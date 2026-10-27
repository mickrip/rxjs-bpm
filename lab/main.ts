import {
	constantTempo,
	jump,
	ramp,
	rushThenHold,
	type TempoCurve,
	wander,
} from "../src/simulate";
import { TempoTracker } from "../src/tempo-tracker";

/**
 * A listening test for the tempo tracker.
 *
 * Two clocks are in play and keeping them straight is most of the work here.
 * The tracker reasons in `performance.now()` milliseconds, which is what a
 * keydown's `timeStamp` already is. Audio must be scheduled against
 * `AudioContext.currentTime`, a different epoch running on the audio thread.
 * `getOutputTimestamp()` reports one instant in both, which is what lets a tap
 * measured on the page clock become a click scheduled on the audio clock.
 *
 * Nothing is ever sounded from a timer callback. A coarse interval wakes up and
 * schedules clicks a little way into the future at exact audio times; the timer
 * only has to be roughly on time, and the audio thread is exactly on time.
 */

const SCENARIOS: Array<{ name: string; tempo: TempoCurve; note: string }> = [
	{ name: "Steady 120", tempo: constantTempo(120), note: "the easy case" },
	{ name: "Steady 96", tempo: constantTempo(96), note: "slower, more room to drift" },
	{ name: "Steady 168", tempo: constantTempo(168), note: "fast" },
	{
		name: "Drifting +1 bpm / 45s",
		tempo: ramp(100, 1 / 45),
		note: "a band gradually rushing",
	},
	{
		name: "Drifting −1 bpm / 30s",
		tempo: ramp(120, -1 / 30),
		note: "a band gradually dragging",
	},
	{
		name: "Rush 120 → 132 over 60s",
		tempo: rushThenHold(120, 132, 60),
		note: "speeds up into the chorus, then holds",
	},
	{
		name: "Jump 120 → 160 at 20s",
		tempo: jump(120, 160, 20),
		note: "an abrupt new section - re-tap to catch it",
	},
	{
		name: "Jump 120 → 84 at 20s",
		tempo: jump(120, 84, 20),
		note: "abrupt half-time feel",
	},
	{ name: "Wandering around 120", tempo: wander(120, 0.5, 7), note: "human rubato" },
];

const LOOKAHEAD_MS = 120; // how far ahead clicks are scheduled
const TICK_MS = 25; // how often the scheduler wakes up
const HISTORY = 240; // beats kept in the visualisation

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
	scenario: $<HTMLSelectElement>("scenario"),
	anchorMode: $<HTMLSelectElement>("anchorMode"),
	start: $<HTMLButtonElement>("start"),
	reset: $<HTMLButtonElement>("reset"),
	calibrate: $<HTMLButtonElement>("calibrate"),
	mute1: $<HTMLButtonElement>("mute1"),
	mute2: $<HTMLButtonElement>("mute2"),
	tapzone: $<HTMLElement>("tapzone"),
	tapHint: $<HTMLElement>("tapHint"),
	pulse1: $<HTMLElement>("pulse1"),
	pulse2: $<HTMLElement>("pulse2"),
	trueBpm: $<HTMLElement>("trueBpm"),
	estBpm: $<HTMLElement>("estBpm"),
	phaseErr: $<HTMLElement>("phaseErr"),
	within: $<HTMLElement>("within"),
	tapCount: $<HTMLElement>("tapCount"),
	horizon: $<HTMLElement>("horizon"),
	latency: $<HTMLElement>("latency"),
	trim: $<HTMLInputElement>("trim"),
	trimValue: $<HTMLElement>("trimValue"),
	strip: $<HTMLCanvasElement>("strip"),
};

interface Sample {
	/** Signed ms by which metronome 2 missed this beat of metronome 1. */
	error: number | null;
	tapped: boolean;
}

let audio: AudioContext | null = null;
let running = false;
let tracker = new TempoTracker();
let tempo: TempoCurve = SCENARIOS[0].tempo;

/**
 * How hard a tap yanks the phase. At 1 the grid moves to sit exactly on the
 * tap, which is what a musician means by tapping to resync; it also means the
 * grid inherits whatever timing error that one tap carried. Averaging rejects
 * that jitter but no longer honours a single correction.
 */
const anchorTaps = () => Number(els.anchorMode.value);

let startPerf = 0;
let nextBeatPerf = 0;
let scheduleTimer: number | null = null;

/** Metronome 2 clicks already committed to the audio thread, so they can be cancelled. */
let pendingTwo: Array<{ at: number; stop: () => void }> = [];
let lastGridSignature = "";

/** Recent metronome 1 beat times, used to score taps during calibration. */
let recentBeats: number[] = [];

/**
 * Calibration measures the whole round trip in one number.
 *
 * The browser reports the audio output path and nothing else. Between a beat
 * sounding and its timestamp reaching this code sit the speaker, the listener,
 * the keyboard, and the operating system - and the player's own habit of
 * anticipating a beat rather than landing on it. All of that shows up as a
 * consistent offset between where taps fall and where the beats actually were,
 * so playing a steady click and measuring that offset captures the lot.
 */
let calibrating = false;
let calibrationOffsets: number[] = [];
const CALIBRATION_TAPS = 16;
const CALIBRATION_DISCARD = 4; // early taps while settling into the pulse

let samples: Sample[] = [];
let tapTotal = 0;
let tappedSinceBeat = false;
let flash1 = 0;
let flash2 = 0;

// --- clock reconciliation ---------------------------------------------------

/** Offset such that audioTime = (perfTime - offset) / 1000. */
let clockOffset = 0;

function syncClocks(ctx: AudioContext): void {
	const stamp = ctx.getOutputTimestamp?.();
	if (
		stamp &&
		stamp.contextTime !== undefined &&
		stamp.performanceTime !== undefined &&
		stamp.contextTime > 0 &&
		stamp.performanceTime > 0
	) {
		clockOffset = stamp.performanceTime - stamp.contextTime * 1000;
	} else {
		// Fallback for engines without getOutputTimestamp or before the audio
		// thread has rendered its first quantum: good to a frame or so.
		clockOffset = performance.now() - ctx.currentTime * 1000;
	}
}

const perfToAudio = (perf: number) => (perf - clockOffset) / 1000;

/**
 * How much earlier than you heard it a sound was actually scheduled.
 *
 * This has to be taken off every tap, or the latency is counted twice. You tap
 * in response to a click that left the scheduler `L` ago, so your tap already
 * carries `L`; snapping the grid to it and then scheduling metronome 2 from
 * that grid adds `L` a second time on the way out, and metronome 2 lands a
 * whole output latency behind metronome 1.
 *
 * The browser reports the audio path only. Keyboard and OS input latency, and
 * a player's own habit of anticipating the beat, are real and unreported - the
 * trim is there to dial in the remainder by ear.
 */
function latencyMs(): number {
	// baseLatency and outputLatency are consecutive stages of the same path -
	// page to audio thread, then audio thread to speaker - so they add. Taking
	// one or the other under-compensates by the whole of the other.
	const base = audio?.baseLatency ?? 0;
	const output = audio?.outputLatency ?? 0;
	return (base + output) * 1000 + Number(els.trim.value);
}

// --- sound ------------------------------------------------------------------

function click(ctx: AudioContext, at: number, freq: number, gain: number): () => void {
	const osc = ctx.createOscillator();
	const env = ctx.createGain();
	osc.frequency.value = freq;
	osc.type = "sine";
	env.gain.setValueAtTime(0, at);
	env.gain.linearRampToValueAtTime(gain, at + 0.001);
	env.gain.exponentialRampToValueAtTime(0.0001, at + 0.055);
	osc.connect(env).connect(ctx.destination);
	osc.start(at);
	osc.stop(at + 0.07);
	return () => {
		try {
			osc.stop();
		} catch {
			// already stopped
		}
	};
}

// --- the scheduler ----------------------------------------------------------

function cancelPendingTwo(after: number): void {
	const keep: typeof pendingTwo = [];
	for (const p of pendingTwo) {
		if (p.at > after) p.stop();
		else keep.push(p);
	}
	pendingTwo = keep;
}

function schedule(): void {
	if (!audio || !running) return;
	const ctx = audio;
	syncClocks(ctx);
	const now = performance.now();
	const horizon = now + LOOKAHEAD_MS;

	// Metronome 1: generated from the scenario's tempo curve.
	while (nextBeatPerf < horizon) {
		if (!els.mute1.classList.contains("off")) {
			click(ctx, perfToAudio(nextBeatPerf), 1150, 0.32);
		}
		recordBeat(nextBeatPerf);
		recentBeats.push(nextBeatPerf);
		if (recentBeats.length > 64) recentBeats.shift();
		nextBeatPerf += 60000 / tempo(nextBeatPerf - startPerf);
	}

	// Metronome 2: derived from the grid. If the grid moved - which a tap makes
	// it do - anything already scheduled is stale and must be pulled back before
	// it sounds, or the correction is heard as a flam against the old beat.
	const grid = calibrating ? null : tracker.current();
	if (grid) {
		const signature = `${grid.periodMs.toFixed(4)}:${grid.anchorMs.toFixed(4)}`;
		if (signature !== lastGridSignature) {
			lastGridSignature = signature;
			cancelPendingTwo(now);
		}
		let n = Math.ceil((now - grid.anchorMs) / grid.periodMs);
		for (;;) {
			const at = grid.anchorMs + n * grid.periodMs;
			if (at >= horizon) break;
			if (at > now && !pendingTwo.some((p) => Math.abs(p.at - at) < 1)) {
				const stopAudio = els.mute2.classList.contains("off")
					? () => {}
					: click(ctx, perfToAudio(at), 760, 0.28);
				const flashTimer = window.setTimeout(
					() => {
						flash2 = performance.now();
					},
					Math.max(0, at - performance.now()),
				);
				pendingTwo.push({
					at,
					stop: () => {
						stopAudio();
						clearTimeout(flashTimer);
					},
				});
			}
			n++;
		}
		pendingTwo = pendingTwo.filter((p) => p.at > now - 200);
	}
}

/** Score one beat of metronome 1 against the grid as it stands right now. */
function recordBeat(beatPerf: number): void {
	const error = tracker.errorAt(beatPerf);
	samples.push({ error, tapped: tappedSinceBeat });
	tappedSinceBeat = false;
	if (samples.length > HISTORY) samples.shift();
	setTimeout(
		() => {
			flash1 = performance.now();
		},
		Math.max(0, beatPerf - performance.now()),
	);
}

// --- input ------------------------------------------------------------------

function onKey(event: KeyboardEvent): void {
	if (event.code !== "Space") return;
	event.preventDefault();
	// Auto-repeat from a held key is not a tap.
	if (event.repeat) return;
	if (!running) {
		void start();
		return;
	}
	// `timeStamp` is a DOMHighResTimeStamp on the same epoch as performance.now(),
	// captured closer to the keypress than this handler runs.
	if (calibrating) {
		recordCalibrationTap(event.timeStamp);
		els.tapzone.classList.add("hit");
		setTimeout(() => els.tapzone.classList.remove("hit"), 90);
		return;
	}
	tracker.addTap(event.timeStamp - latencyMs());
	tapTotal++;
	tappedSinceBeat = true;
	els.tapzone.classList.add("hit");
	setTimeout(() => els.tapzone.classList.remove("hit"), 90);
	schedule();
}

/** Offset of one tap from the beat it was aiming at, gathered during calibration. */
function recordCalibrationTap(tapTime: number): void {
	if (recentBeats.length < 2) return;
	let nearest = recentBeats[0];
	for (const b of recentBeats) {
		if (Math.abs(b - tapTime) < Math.abs(nearest - tapTime)) nearest = b;
	}
	// Wrap into half a beat either side. Only beats already scheduled are known -
	// a little over a tenth of a second ahead - so a tap that anticipates the next
	// beat has no next beat to match against and would otherwise be recorded as
	// nearly a whole beat late rather than slightly early. Players habitually tap
	// early, so this is the common case, not the corner one.
	const period = recentBeats[recentBeats.length - 1] - recentBeats[recentBeats.length - 2];
	let offset = tapTime - nearest;
	if (period > 0) {
		offset = ((((offset + period / 2) % period) + period) % period) - period / 2;
	}
	calibrationOffsets.push(offset);
	const done = calibrationOffsets.length;
	els.tapHint.textContent = `calibrating — ${Math.max(0, CALIBRATION_TAPS - done)} more`;
	if (done < CALIBRATION_TAPS) return;

	// Median of the settled taps, so one fumble cannot skew the result.
	const settled = calibrationOffsets.slice(CALIBRATION_DISCARD).sort((a, b) => a - b);
	const measured = settled[settled.length >> 1];
	const base = audio?.baseLatency ?? 0;
	const output = audio?.outputLatency ?? 0;
	const reported = (base + output) * 1000;
	const wanted = measured - reported;
	const trim = Math.round(Math.max(-120, Math.min(120, wanted)));
	els.trim.value = String(trim);
	els.trimValue.textContent = `${trim} ms`;
	calibrating = false;
	els.calibrate.textContent = "Calibrate…";
	// Spread of the settled taps, so a measurement taken while flailing is visibly
	// untrustworthy rather than silently applied.
	const spread = settled[settled.length - 1] - settled[0];
	els.tapHint.textContent =
		Math.abs(wanted - trim) > 1
			? `measured ${measured.toFixed(0)}ms, beyond what the trim covers — tap closer to the beat and try again`
			: `measured ${measured.toFixed(0)}ms round trip (${reported.toFixed(0)}ms of it reported by the browser, ` +
				`spread ${spread.toFixed(0)}ms) — trim set to ${trim >= 0 ? "+" : ""}${trim}ms`;
	tracker = new TempoTracker({ anchorTaps: anchorTaps() });
}

// --- lifecycle --------------------------------------------------------------

async function start(): Promise<void> {
	if (!audio) audio = new AudioContext();
	if (audio.state === "suspended") await audio.resume();
	syncClocks(audio);

	tracker = new TempoTracker({ anchorTaps: anchorTaps() });
	samples = [];
	recentBeats = [];
	tapTotal = 0;
	pendingTwo = [];
	lastGridSignature = "";
	startPerf = performance.now() + 200;
	nextBeatPerf = startPerf;
	running = true;

	els.start.textContent = "Stop";
	els.start.classList.add("running");
	els.tapHint.textContent = "tap along with metronome 1";
	if (scheduleTimer !== null) clearInterval(scheduleTimer);
	scheduleTimer = window.setInterval(schedule, TICK_MS);
}

function stop(): void {
	running = false;
	if (scheduleTimer !== null) clearInterval(scheduleTimer);
	scheduleTimer = null;
	cancelPendingTwo(0);
	els.start.textContent = "Start";
	els.start.classList.remove("running");
	els.tapHint.textContent = "press to tap the beat";
}

// --- rendering --------------------------------------------------------------

function draw(): void {
	const c = els.strip;
	const ctx = c.getContext("2d");
	if (!ctx) return;
	const w = c.width;
	const h = c.height;
	const mid = h / 2;
	const scale = mid / 60; // ±60ms fills the height

	ctx.clearRect(0, 0, w, h);

	// the ±20ms "sounds like one click" band
	ctx.fillStyle = "rgba(90, 200, 160, 0.10)";
	ctx.fillRect(0, mid - 20 * scale, w, 40 * scale);
	ctx.strokeStyle = "rgba(140, 150, 170, 0.35)";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(0, mid + 0.5);
	ctx.lineTo(w, mid + 0.5);
	ctx.stroke();

	const colWidth = w / HISTORY;
	samples.forEach((s, i) => {
		const x = i * colWidth;
		if (s.tapped) {
			ctx.fillStyle = "rgba(120, 160, 255, 0.30)";
			ctx.fillRect(x, 0, Math.max(1, colWidth), h);
		}
		if (s.error === null) return;
		const clamped = Math.max(-60, Math.min(60, s.error));
		const y = mid + clamped * scale;
		const good = Math.abs(s.error) <= 20;
		ctx.fillStyle = good ? "rgba(90, 210, 165, 0.95)" : "rgba(240, 150, 90, 0.95)";
		const top = Math.min(mid, y);
		ctx.fillRect(x, top, Math.max(1.5, colWidth - 0.5), Math.max(1.5, Math.abs(y - mid)));
	});

	const now = performance.now();
	els.pulse1.classList.toggle("lit", now - flash1 < 90);
	els.pulse2.classList.toggle("lit", now - flash2 < 90);

	const grid = tracker.current();
	els.trueBpm.textContent = running ? tempo(Math.max(0, now - startPerf)).toFixed(1) : "—";
	els.estBpm.textContent = grid ? (60000 / grid.periodMs).toFixed(1) : "—";
	els.horizon.textContent = grid ? String(grid.horizon) : "—";
	els.latency.textContent = running ? latencyMs().toFixed(1) : "—";
	els.tapCount.textContent = String(tapTotal);

	const scored = samples.filter((s) => s.error !== null).map((s) => s.error as number);
	if (scored.length) {
		const recent = scored.slice(-32);
		const meanAbs = recent.reduce((a, b) => a + Math.abs(b), 0) / recent.length;
		els.phaseErr.textContent = meanAbs.toFixed(1);
		els.phaseErr.classList.toggle("bad", meanAbs > 20);
		const within = scored.filter((e) => Math.abs(e) <= 20).length / scored.length;
		els.within.textContent = (within * 100).toFixed(0);
	} else {
		els.phaseErr.textContent = "—";
		els.within.textContent = "—";
	}

	requestAnimationFrame(draw);
}

// --- wiring -----------------------------------------------------------------

SCENARIOS.forEach((s, i) => {
	const opt = document.createElement("option");
	opt.value = String(i);
	opt.textContent = `${s.name} — ${s.note}`;
	els.scenario.append(opt);
});

els.scenario.addEventListener("change", () => {
	tempo = SCENARIOS[Number(els.scenario.value)].tempo;
	if (running) void start();
});

els.anchorMode.addEventListener("change", () => {
	// Swap the tracker but keep the run going, so the difference is audible
	// against the same metronome 1 rather than needing a restart.
	tracker = new TempoTracker({ anchorTaps: anchorTaps() });
	cancelPendingTwo(performance.now());
});

els.start.addEventListener("click", () => (running ? stop() : void start()));
els.calibrate.addEventListener("click", () => {
	if (calibrating) {
		calibrating = false;
		els.calibrate.textContent = "Calibrate…";
		els.tapHint.textContent = "tap along with metronome 1";
		return;
	}
	if (!running) void start();
	calibrating = true;
	calibrationOffsets = [];
	els.calibrate.textContent = "Cancel";
	els.tapHint.textContent = `calibrating — tap ${CALIBRATION_TAPS} beats`;
});

els.reset.addEventListener("click", () => {
	tracker = new TempoTracker({ anchorTaps: anchorTaps() });
	cancelPendingTwo(performance.now());
	samples = samples.map((s) => ({ ...s, error: null }));
});

for (const btn of [els.mute1, els.mute2]) {
	btn.addEventListener("click", () => {
		btn.classList.toggle("off");
		btn.classList.toggle("on");
	});
}

els.trim.addEventListener("input", () => {
	els.trimValue.textContent = `${els.trim.value} ms`;
});

window.addEventListener("keydown", onKey);
requestAnimationFrame(draw);
