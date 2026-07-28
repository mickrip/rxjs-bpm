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

Accepted intervals go into a ring buffer of the last `windowSize = 12`
intervals (≈ 3 bars of 4/4). Bigger than the current 8-timestamp window for
better averaging, still small enough to track a change within a couple of
bars.

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
  trusting). Folded samples are flagged and get **half weight** in Stage 6.

### Stage 5 — Robust outlier rejection (median + MAD)

The current code's "trust the first interval" baseline is fragile — if the
baseline itself is bad, everything is judged against garbage. Replace with a
median-based test over the window:

```
m   = median(window)
dev = |interval - m| / m
keep iff dev ≤ outlierTolerance (0.12)
```

Median is robust up to 50% contamination, so one or two sloppy taps never
shift the baseline. Rejected intervals still occupy a slot in the ring buffer
(so persistent "outliers" — i.e. an actual tempo change — age the old data
out) but are excluded from the average.

### Stage 6 — Weighted estimate

Average the surviving intervals with **exponential recency weighting**, then
convert once at the end:

```
weight(i) = halfLifeDecay ^ age(i)        // default decay 0.85 per step
          × 0.5 if the sample was octave-folded
meanITI   = Σ(w·interval) / Σw
rawBpm    = 60000 / meanITI
```

Two fixes vs. the current implementation baked in here:

- **Average intervals, then invert** — the current code converts each interval
  to BPM first and averages BPMs, which is a different (biased) statistic
  because `1/x` is convex. Averaging in interval space is the correct
  period estimate.
- Recency weighting means a genuine tempo change pulls the estimate over
  within ~4–6 taps instead of waiting for the whole window to flush.

### Stage 7 — Output stabilisation (hysteresis + quantisation)

`rawBpm` still wobbles with human timing (±2–4 BPM is normal even for good
players). The *reported* `bpm` goes through a hysteresis latch:

```
if no reported bpm yet:            report round(rawBpm × 2) / 2   // 0.5 BPM grid
else if |rawBpm - reported| ≥ hysteresisBpm (1.5):
    count consecutive readings beyond the band
    if count ≥ confirmTaps (3):    report the new quantised value
else:                              keep reporting the old value; reset count
```

- The 0.5-BPM quantisation grid (`quantizeBpm`, settable to 1.0 or 0 for off)
  gives downstream consumers a value that *stays put*.
- Requiring `confirmTaps` consecutive out-of-band readings distinguishes "the
  drummer moved to 126" (sustained) from "I tapped one beat late" (transient).
- This replaces the current `distinctUntilChanged` + late rounding, which
  compares unrounded floats and re-emits the same rounded number repeatedly.

### Stage 8 — State machine & confidence

```
idle ── tap ──▶ collecting ── ≥ minTaps(4) & CV ≤ 0.1 ──▶ locked
  ▲                │  ▲                                      │
  └── reset() ─────┘  └───── session reset (keeps bpm) ◀─────┘
```

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
| `windowSize` | 12 | Intervals kept |
| `foldTolerance` | 0.15 | Octave-fold matching band |
| `outlierTolerance` | 0.12 | Median-deviation rejection band |
| `halfLifeDecay` | 0.85 | Recency weight per step of age |
| `minTaps` | 4 | Intervals needed to lock |
| `hysteresisBpm` | 1.5 | Dead band around reported BPM |
| `confirmTaps` | 3 | Out-of-band readings needed to re-latch |
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
