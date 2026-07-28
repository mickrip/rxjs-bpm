# PLAN: Stable live tap-tempo engine

## 1. Goal

Detect and report a **stable tempo (BPM)** from a human tapping a MIDI foot
switch **while a song is playing** — drum loop in the background, live drummer
on top. The reported tempo feeds another library (delay lines, loop sync,
lighting, etc.), so the output must be:

- **Stable** — no jitter between 119.2 / 120.4 / 119.8 on every tap. Downstream
  consumers should see `120` and have it *stay* `120` until the band actually
  changes tempo.
- **Responsive** — a usable estimate within 3–4 taps, and it must follow a real
  tempo change (new song section, drummer pushes) within a bar or two.
- **Forgiving** — humans on foot switches double-trigger, miss beats, tap
  half-time for a bar, and stop tapping entirely once the tempo is locked.

## 2. Design principles

1. **Emitter-agnostic core.** The engine is a plain class with a single input
   method: `tap(timestampMs)`. No RxJS, no `EventEmitter`, no timers, no
   `performance.now()` inside the core. Anything that can produce a timestamp
   can drive it.
2. **Time is an input, not an ambient.** The caller supplies timestamps (MIDI
   event time, `performance.now()`, audio-clock time). This makes the core
   100% deterministic and testable without fake timers.
3. **No hidden subscriptions.** Unlike the current `createBPMObservable`, the
   core never subscribes to anything and holds no resources. Adapters own
   lifecycle.
4. **Report state, not just events.** Every tap returns a full reading
   (`bpm`, `confidence`, `phase`, `tapCount`); adapters decide what "emit"
   means for their world.

## 3. Architecture

```
src/
  core/
    tap-tempo.ts      # TapTempoEngine — the pure core (no deps)
    types.ts          # TempoReading, TapTempoOptions, EngineState
  adapters/
    rxjs.ts           # createBPMObservable(event$) — thin wrapper, keeps rxjs optional
    callback.ts       # createTapTempo({ onReading }) — plain-callback adapter
  index.ts            # re-exports core; rxjs adapter exported from a subpath
```

- `rxjs` moves from `dependencies` to **`peerDependencies` (optional)** and the
  adapter is exposed via a package export (`@mickrip/rxjs-bpm/rxjs`) so users
  who don't use RxJS never pull it in.
- The core has **zero runtime dependencies**.

### Core API sketch

```ts
interface TempoReading {
  bpm: number | null;        // stable, quantized output (null until locked-ish)
  rawBpm: number | null;     // unsmoothed instantaneous estimate (debug/UI)
  confidence: number;        // 0..1 — how much to trust bpm right now
  state: 'idle' | 'collecting' | 'locked';
  tapCount: number;          // taps in the current session
  changed: boolean;          // true iff `bpm` differs from the previous reading
}

class TapTempoEngine {
  constructor(options?: Partial<TapTempoOptions>);
  tap(timestampMs: number): TempoReading;   // the only input
  reset(): void;                            // manual "new song" reset
  reading(): TempoReading;                  // current state without tapping
}
```

`changed` is how adapters implement "only notify downstream when the tempo
actually moved" without the core knowing anything about emission.

## 4. The algorithm

The engine is a pipeline over **inter-tap intervals** (ITIs), plus a small
state machine on top. All thresholds below are the `TapTempoOptions` defaults
(see §6) and every one of them is configurable.

### Stage 0 — Input validation

- Reject non-finite timestamps and timestamps that go **backwards** (can
  happen if the caller mixes clocks). A backwards tap is dropped, not an error.

### Stage 1 — Refractory gate (debounce)

A foot switch physically bounces and players double-trigger. Reject any tap
closer than the refractory window to the previous accepted tap:

```
refractory = max(refractoryMinMs, refractoryBeatFraction × currentBeatMs)
           = max(100ms, 0.4 × beat)            // defaults
```

- With no estimate yet, use `refractoryMinMs` alone.
- This is deliberately **adaptive**: at 60 BPM (1000ms beats) anything under
  400ms is noise; at 240 BPM (250ms beats) the floor of 100ms still protects
  against contact bounce without eating real taps.
- This replaces the current hard-coded `throttleTime(200)` which silently caps
  the detectable tempo at 300 BPM and is too permissive at slow tempos.

### Stage 2 — Session segmentation (the "gave up tapping" gate)

If the gap since the last accepted tap exceeds the session timeout, the new
tap **starts a new measurement session** instead of producing one giant
interval that poisons the window:

```
timeout = sessionTimeoutBeats × currentBeatMs   // default 2.5 beats
        (fallback: sessionTimeoutMs = 2000ms when no estimate exists)
```

Critically for the band scenario: **a session reset does not clear the
reported BPM.** The engine keeps the last locked tempo (state stays `locked`,
confidence decays — see Stage 8) and the new session's taps either *confirm*
it or *replace* it. The player can stop tapping for three minutes and the
downstream library keeps its tempo.

### Stage 3 — Interval window

Accepted intervals go into a ring buffer of the last `windowSize = 16`
intervals (4 bars of 4/4). Each sample stores both its normalized one-beat
value and its original gap + beat span (see Stage 4), which the estimator
depends on.

### Stage 4 — Octave folding (missed taps & double taps)

Before outlier rejection, try to *rescue* intervals that are musically
related to the running median rather than throwing them away:

```
m = median(window)
if |interval / (2m) - 1| ≤ foldTolerance (0.15):  interval := interval / 2   // missed a tap
if |interval / (m/2) - 1| ≤ foldTolerance:        interval := interval × 2   // extra tap slipped past Stage 1
```

- A missed tap produces one interval at ~2× the beat; folding it recovers a
  perfectly good sample instead of discarding data.
- Folding only activates once the window has ≥ 4 intervals (a median worth
  trusting). A folded sample records its true beat span (2 for a missed tap,
  0.5 for a double tap), which keeps the Stage 6 estimator exact.

### Stage 5 — Outlier statistics (median + deviation band)

The current code's "trust the first interval" baseline is fragile — if the
baseline itself is bad, everything is judged against garbage. Replace with a
median-based test over the normalized window values:

```
m   = median(window values)
dev = |value - m| / m
consistent iff dev ≤ outlierTolerance (0.12)
```

Median is robust up to 50% contamination, so one or two sloppy taps never
shift the baseline. **Implementation finding:** these statistics gate
locking and feed confidence, but they must NOT filter the estimate itself —
excluding middle samples destroys the telescoping property Stage 6 relies
on, and beat-count normalization already absorbs musical outliers.

### Stage 6 — Telescoped rate estimators

The key insight (learned the hard way in M1): consecutive intervals share
tap timestamps, so **summing a contiguous run of gaps telescopes the jitter
away** — only the two endpoint taps' noise survives. Any per-interval
average (weighted or not) throws that property out and *amplifies* human
jitter: a 6%-sloppy player pushed a weighted-mean estimator up to 11 BPM
off, while the telescoped rate stays within ~1 BPM.

Both estimates are therefore beats-per-timespan rates:

```
rate(samples) = 60000 × Σbeats / Σgap
rawBpm        = rate(last ≤4 samples)   // fast tracker: DETECTS change
preciseBpm    = rate(whole window)      // stable: the value REPORTED
```

Folded samples contribute their true beat span (0.5 / 2), so double taps
and missed beats don't bias the rate. σ of the precise estimate at 6% tap
jitter over a 16-beat window is ≈ 0.6 BPM; the fast tracker is noisy
(±2–3 BPM) but reacts to a real change within ~3 taps.

### Stage 7 — Output stabilisation (hysteresis + quantisation)

`rawBpm` wobbles with human timing (±2–4 BPM is normal even for good
players). The *reported* `bpm` goes through a hysteresis latch in which the
fast tracker only **triggers** and the precise estimate **judges**:

```
if no reported bpm yet:                     report quantize(preciseBpm)
else if |rawBpm - reported| ≥ hysteresisBpm (1.5):
    count consecutive readings beyond the band
    if count ≥ confirmTaps (3) AND |preciseBpm - reported| ≥ hysteresisBpm:
        report quantize(preciseBpm)
else (in-band) — drift correction:
    if quantize(preciseBpm) disagrees with the report by the SAME value
    for driftTaps (6) consecutive taps: adopt it quietly
```

- The 0.5-BPM quantisation grid (`quantizeBpm`, settable to 1.0 or 0 for off)
  gives downstream consumers a value that *stays put*.
- Requiring `confirmTaps` consecutive out-of-band readings distinguishes "the
  drummer moved to 126" (sustained) from "I tapped one beat late" (transient),
  and the precise-judge condition stops fast-tracker noise from re-latching
  when the underlying tempo hasn't moved.
- Drift correction fixes the small settle error a re-latch can leave inside
  the dead band (e.g. landing on 125.5 during a 120→126 transition). Jittery
  input keeps flipping the candidate value, so it never fires on noise.
- This replaces the current `distinctUntilChanged` + late rounding, which
  compares unrounded floats and re-emits the same rounded number repeatedly.

### Stage 8 — State machine & confidence

```
idle ── tap ──▶ collecting ── ≥ minTaps(4) & CV ≤ 0.1 & SE gate ──▶ locked
  ▲                │  ▲                                               │
  └── reset() ─────┘  └───────── session reset (keeps bpm) ◀──────────┘
```

The SE gate (`cv/√n ≤ lockSeMax`, waived once the window is full) makes
lock time adapt to the player: machine-clean tapping locks at `minTaps`,
sloppy tapping has to earn its first report with more taps.

- `idle`: no data. `bpm = null`.
- `collecting`: fewer than `minTaps` intervals, or the window is too noisy.
  `rawBpm` is available for UIs, `bpm` stays `null` (or last locked value if
  we got here via session reset) — downstream never sees a half-baked number.
- `locked`: stable output with hysteresis active.

Confidence (exposed on every reading, useful for the consuming library to
decide whether to hard-sync):

```
confidence = tapFactor × consistencyFactor × freshnessFactor
  tapFactor         = min(1, intervals / windowSize)
  consistencyFactor = clamp(1 - CV / 0.15, 0, 1)     // CV = stddev/mean of kept intervals
  freshnessFactor   = decays from 1 → 0.5 as time since last tap grows past
                      ~8 beats (evaluated lazily on read — no timers in core)
```

- **No BPM range clamp by default.** The current `filter(bpm > 60)` silently
  swallows every slow song. Optional `minBpm`/`maxBpm` options exist for
  callers that want a sanity range, applied as a fold-into-range (halve/double)
  rather than a drop where possible.

## 5. Worked edge cases

| Scenario | What happens |
| --- | --- |
| Switch bounce (tap + 30ms ghost) | Stage 1 drops the ghost. |
| Double-tap that beats the refractory gate | Stage 4 folds it (×2) or Stage 5 rejects it; window survives. |
| Missed beat (one 2×-beat interval) | Stage 4 folds it to a normal sample at half weight. |
| Tapped half-time for two bars | Intervals fold consistently; estimate unchanged. If the player *intends* half-time, sustained unfoldable drift eventually re-locks via Stage 7. |
| Drummer moves 120 → 126 | Old samples age out of the 12-slot window; ~3 consecutive out-of-band raws re-latch the report within ~4–6 taps. |
| Player stops tapping for a verse | Session timeout (Stage 2); `bpm` holds, freshness/confidence decay; next taps start a clean window against the held tempo. |
| Song stops, new song starts | Caller invokes `reset()` (wire it to a long-press or a different switch), or just taps — the new tempo wins after `confirmTaps`. |
| Clock hiccup / timestamp goes backwards | Stage 0 drops the tap. |

## 6. Default parameters

| Option | Default | Meaning |
| --- | --- | --- |
| `refractoryMinMs` | 100 | Absolute debounce floor |
| `refractoryBeatFraction` | 0.4 | Adaptive debounce vs. current beat |
| `sessionTimeoutBeats` | 2.5 | Gap that starts a new session |
| `sessionTimeoutMs` | 2000 | Session gap fallback with no estimate |
| `windowSize` | 16 | Intervals kept (4 bars of 4/4) |
| `foldTolerance` | 0.15 | Octave-fold matching band |
| `outlierTolerance` | 0.12 | Median-deviation consistency band |
| `minTaps` | 4 | Intervals needed to lock |
| `lockCvMax` | 0.1 | Max window CV to lock |
| `lockSeMax` | 0.015 | Max relative standard error for first report |
| `hysteresisBpm` | 1.5 | Dead band around reported BPM |
| `confirmTaps` | 3 | Out-of-band readings needed to re-latch |
| `driftTaps` | 6 | Consecutive agreeing taps for in-band drift correction |
| `quantizeBpm` | 0.5 | Output grid (0 = off) |
| `minBpm` / `maxBpm` | none | Optional sanity range (fold, don't drop) |

## 7. Adapters

### RxJS (backwards-compatible surface)

```ts
// @mickrip/rxjs-bpm/rxjs
export function createBPMObservable(
  event$: Observable<unknown>,
  options?: Partial<TapTempoOptions> & { now?: () => number },
): Observable<TempoReading>;
```

Implementation: `event$.pipe(map(() => engine.tap(now())), filter(r => r.changed), share())`.
Fixes the current adapter's flaws: no internal `.subscribe()` (teardown works),
no `ReplaySubject(0)` (late subscribers get the current reading via
`startWith(engine.reading())`).

### Plain callback (the agnostic default)

```ts
const tempo = createTapTempo({
  onChange: (r) => otherLibrary.setTempo(r.bpm),   // fires only when bpm moves
  onReading: (r) => ui.render(r),                  // optional: every tap
});
midiInput.on('noteon', (e) => tempo.tap(e.timestamp));
```

This is a ~15-line wrapper over the core — proof that the core is genuinely
emitter-agnostic.

## 8. Testing plan

All core tests are **pure and timer-free**: feed literal timestamp arrays,
assert on readings. No `setTimeout`, no fake clocks (the current test takes
2+ real seconds; the new suite should run in milliseconds).

1. **Golden paths** — steady 60 / 120 / 180 / 240 BPM tap sequences lock to
   the exact value within `minTaps`.
2. **Jitter** — 120 BPM with ±3% and ±6% Gaussian jitter (precomputed fixture
   arrays, seeded): reported BPM stays within ±0.5 and never flaps once locked.
3. **Fault injection** — fixtures for each row of the §5 table (bounce, double
   tap, missed beat, half-time bar, tempo step 120→126, long pause + resume).
4. **Hysteresis** — a raw estimate oscillating ±1 BPM around 120 produces
   exactly one report.
5. **Property tests** (fast-check, dev-dep): for any tempo in [40, 300] and
   any jitter ≤ 4%, the locked BPM is within 1% of ground truth; folding never
   fires on clean input.
6. **Adapter tests** — RxJS adapter: emission only on `changed`, teardown
   unsubscribes, late subscriber gets current reading. Callback adapter:
   `onChange` vs `onReading` contract.

## 9. Milestones

1. **M1 — Core engine**: `TapTempoEngine` + types, Stages 0–8, full core test
   suite. (The deliverable; everything else is packaging.)
2. **M2 — Adapters**: callback + RxJS adapters, package `exports` map, move
   `rxjs` to optional peer dependency, deprecate-but-keep the old
   `createBPMObservable(event$)` signature (returns `Observable<number>` via
   `map(r => r.bpm)` for one release).
3. **M3 — Hardening**: property tests, a `simulate()` dev harness that replays
   recorded MIDI tap logs, README with the band use case front and centre.
