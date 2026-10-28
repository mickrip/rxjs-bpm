import { Subject, type Subscription } from "rxjs";
import { type Pulse, pulse } from "../src/pulse";

/**
 * A visual metronome that follows the player, driven by the library's `pulse()`
 * operator exactly as a lighting rig would be.
 *
 * Spacebar taps go into a subject; `pulse()` turns them into beats. Pulses are
 * requested a little ahead of their beat (`PULSE_LEAD_MS`), and each carries the
 * exact beat time, so the lamp does not depend on when the timer happened to
 * fire: every animation frame lights the lamp from the most recent beat time.
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
/**
 * How far ahead of its beat a pulse is delivered. It must cover the frame lead
 * and timer lateness, and no more: a pulse already delivered cannot be recalled,
 * so a tap that lands inside this window corrects from the following beat.
 */
const PULSE_LEAD_MS = 40;

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

const taps$ = new Subject<number>();
let pulseSub: Subscription | null = null;
/** Pulses delivered so far, oldest first. Some may be for beats still ahead. */
let pulses: Pulse[] = [];
let tapTotal = 0;
let lastTapAt = Number.NEGATIVE_INFINITY;
/** Signed ms of each recent tap against the beat the lamp showed. Positive is late. */
let tapErrors: number[] = [];

function start(): void {
	pulseSub?.unsubscribe();
	pulses = [];
	tapTotal = 0;
	tapErrors = [];
	pulseSub = taps$
		.pipe(
			pulse({
				timestamp: (t) => t,
				leadMs: PULSE_LEAD_MS,
				anchorTaps: Number(els.anchorMode.value),
			}),
		)
		.subscribe((p) => {
			pulses.push(p);
			if (pulses.length > 8) pulses.shift();
		});
}

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

/** Signed ms from the nearest beat the lamp showed or will show to `at`. */
function errorAgainstLight(at: number): number | null {
	const last = pulses.at(-1);
	if (!last) return null;
	const candidates = [...pulses.map((p) => p.time), last.time + last.periodMs];
	let nearest = candidates[0];
	for (const c of candidates) if (Math.abs(c - at) < Math.abs(nearest - at)) nearest = c;
	return at - nearest;
}

function onKey(event: KeyboardEvent): void {
	if (event.code === "Escape") {
		start();
		return;
	}
	if (event.code !== "Space") return;
	event.preventDefault();
	// Auto-repeat from a held key is not a tap.
	if (event.repeat) return;

	// `timeStamp` is on the performance.now() epoch and is taken when the event
	// arrives, so a busy main thread does not shift it.
	const at = event.timeStamp;

	// Score the tap against the light before the tap moves the beat.
	const err = errorAgainstLight(at);
	if (err !== null) {
		tapErrors.push(err);
		if (tapErrors.length > ERROR_HISTORY) tapErrors.shift();
	}

	taps$.next(at);
	tapTotal++;
	lastTapAt = at;
}

// --- rendering --------------------------------------------------------------

function draw(now: number): void {
	trackFrame(now);
	const seenAt = now + leadMs();

	// The latest beat this frame will be seen after. Its pulse has already
	// arrived, because pulses are delivered ahead of their beat.
	let current: Pulse | undefined;
	for (const p of pulses) if (p.time <= seenAt) current = p;

	let glow = 0;
	let phase = 0;
	if (current) {
		const age = seenAt - current.time;
		const fade = Math.min(FLASH_MS, current.periodMs * 0.45);
		if (age < fade) glow = (1 - age / fade) ** 2;
		phase = Math.min(1, age / current.periodMs);
	}

	els.lamp.style.setProperty("--glow", glow.toFixed(3));
	els.phase.style.width = `${(phase * 100).toFixed(1)}%`;

	const tapAge = performance.now() - lastTapAt;
	const hit = tapAge < TAP_RING_MS ? 1 - tapAge / TAP_RING_MS : 0;
	els.tapring.style.setProperty("--hit", hit.toFixed(3));

	const latest = pulses.at(-1);
	els.bpm.textContent = latest ? latest.bpm.toFixed(1) : "—";
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

	els.hint.textContent = latest
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

els.anchorMode.addEventListener("change", start);
els.reset.addEventListener("click", start);
els.lead.addEventListener("input", () => {
	els.leadValue.textContent = `${els.lead.value} ms`;
});
// A focused button or select would take the spacebar for itself.
for (const el of [els.anchorMode, els.reset, els.lead]) {
	el.addEventListener("change", () => el.blur());
	el.addEventListener("click", () => el.blur());
}

window.addEventListener("keydown", onKey);
start();
requestAnimationFrame(draw);
