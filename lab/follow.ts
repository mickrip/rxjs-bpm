import { TempoTracker } from "../src/tempo-tracker";

/**
 * A visual metronome that follows the player.
 *
 * Taps go into the tracker on the `performance.now()` clock, and the lamp is
 * lit from the beat grid it returns. There is no timer per beat: every
 * animation frame asks the grid where the nearest beat is and sets the lamp's
 * brightness from that, so the flash cannot drift from the grid.
 *
 * A frame drawn now reaches the screen roughly one frame later. To make the
 * flash appear on the beat rather than one frame after it, each frame is drawn
 * for the moment it will be seen: `now + lead`. The lead is the measured frame
 * interval plus a manual trim, which also absorbs keyboard and display latency
 * that the browser does not report.
 */

const FLASH_MS = 110; // how long a flash takes to fade
const TAP_RING_MS = 120; // how long the tap marker stays visible
const ERROR_HISTORY = 8;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
	anchorMode: $<HTMLSelectElement>("anchorMode"),
	lead: $<HTMLInputElement>("lead"),
	leadValue: $<HTMLElement>("leadValue"),
	reset: $<HTMLButtonElement>("reset"),
	lamp: $<HTMLElement>("lamp"),
	tapring: $<HTMLElement>("tapring"),
	phase: $<HTMLElement>("phase"),
	hint: $<HTMLElement>("hint"),
	bpm: $<HTMLElement>("bpm"),
	lastErr: $<HTMLElement>("lastErr"),
	meanErr: $<HTMLElement>("meanErr"),
	taps: $<HTMLElement>("taps"),
	frame: $<HTMLElement>("frame"),
};

const anchorTaps = () => Number(els.anchorMode.value);

let tracker = new TempoTracker({ anchorTaps: anchorTaps() });
let tapTotal = 0;
let lastTapAt = Number.NEGATIVE_INFINITY;
/** Signed ms of each recent tap against the beat the lamp showed. Positive is late. */
let tapErrors: number[] = [];

/** Beat time of the flash in progress, so a grid that moves under it does not flash twice. */
let flashBeat = Number.NEGATIVE_INFINITY;

// --- frame timing -----------------------------------------------------------

let lastFrame = 0;
const frameDeltas: number[] = [];

/** Median recent frame interval, which is roughly how late a drawn frame is seen. */
function frameMs(): number {
	if (frameDeltas.length < 5) return 1000 / 60;
	const sorted = [...frameDeltas].sort((a, b) => a - b);
	return sorted[sorted.length >> 1];
}

function trackFrame(now: number): void {
	if (lastFrame > 0) {
		const delta = now - lastFrame;
		// Ignore stalls such as a backgrounded tab, which say nothing about vsync.
		if (delta > 2 && delta < 100) {
			frameDeltas.push(delta);
			if (frameDeltas.length > 60) frameDeltas.shift();
		}
	}
	lastFrame = now;
}

const leadMs = () => frameMs() + Number(els.lead.value);

// --- input ------------------------------------------------------------------

function onKey(event: KeyboardEvent): void {
	if (event.code === "Escape") {
		reset();
		return;
	}
	if (event.code !== "Space") return;
	event.preventDefault();
	// Auto-repeat from a held key is not a tap.
	if (event.repeat) return;

	// `timeStamp` is on the performance.now() epoch and is taken when the event
	// arrives, so a busy main thread does not shift it.
	const at = event.timeStamp;

	// Score the tap against the light before the tap moves the grid. The lamp
	// is drawn `lead` early, so the beat the player saw is the grid beat itself.
	const err = tracker.errorAt(at);
	if (err !== null) {
		tapErrors.push(-err);
		if (tapErrors.length > ERROR_HISTORY) tapErrors.shift();
	}

	tracker.addTap(at);
	tapTotal++;
	lastTapAt = at;
}

function reset(): void {
	tracker = new TempoTracker({ anchorTaps: anchorTaps() });
	tapTotal = 0;
	tapErrors = [];
	flashBeat = Number.NEGATIVE_INFINITY;
}

// --- rendering --------------------------------------------------------------

function draw(now: number): void {
	trackFrame(now);
	const seenAt = now + leadMs();
	const grid = tracker.current();

	let glow = 0;
	let phase = 0;
	if (grid) {
		const { anchorMs, periodMs } = grid;
		const beats = (seenAt - anchorMs) / periodMs;
		const beat = anchorMs + Math.floor(beats) * periodMs;
		phase = beats - Math.floor(beats);
		// Start a new flash only for a beat clearly distinct from the last one. A
		// snapping tap can shift the grid by a few ms just after a flash began,
		// which would otherwise restart it.
		if (seenAt - beat < FLASH_MS && Math.abs(beat - flashBeat) > periodMs / 2) {
			flashBeat = beat;
		}
		const age = seenAt - flashBeat;
		const fade = Math.min(FLASH_MS, periodMs * 0.45);
		if (age >= 0 && age < fade) glow = (1 - age / fade) ** 2;
	}

	els.lamp.style.setProperty("--glow", glow.toFixed(3));
	els.phase.style.width = `${(phase * 100).toFixed(1)}%`;

	const tapAge = performance.now() - lastTapAt;
	const hit = tapAge < TAP_RING_MS ? 1 - tapAge / TAP_RING_MS : 0;
	els.tapring.style.setProperty("--hit", hit.toFixed(3));

	els.bpm.textContent = grid ? (60000 / grid.periodMs).toFixed(1) : "—";
	els.taps.textContent = String(tapTotal);
	els.frame.textContent = frameMs().toFixed(1);

	const last = tapErrors.at(-1);
	els.lastErr.textContent = last === undefined ? "—" : signed(last);
	if (tapErrors.length) {
		const mean = tapErrors.reduce((a, b) => a + b, 0) / tapErrors.length;
		els.meanErr.textContent = signed(mean);
	} else {
		els.meanErr.textContent = "—";
	}

	els.hint.textContent = grid
		? "keep tapping to steer, or stop and it carries on"
		: tapTotal === 0
			? "tap the spacebar 4 times to start"
			: "keep tapping…";

	requestAnimationFrame(draw);
}

const signed = (ms: number) => {
	const rounded = Math.round(ms);
	return `${rounded > 0 ? "+" : ""}${rounded === 0 ? 0 : rounded}`;
};

// --- wiring -----------------------------------------------------------------

els.anchorMode.addEventListener("change", reset);
els.reset.addEventListener("click", reset);
els.lead.addEventListener("input", () => {
	els.leadValue.textContent = `${els.lead.value} ms`;
});
// A focused button or select would take the spacebar for itself.
for (const el of [els.anchorMode, els.reset, els.lead]) {
	el.addEventListener("change", () => el.blur());
	el.addEventListener("click", () => el.blur());
}

window.addEventListener("keydown", onKey);
requestAnimationFrame(draw);
