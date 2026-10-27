/**
 * A simulated rehearsal room, for testing tempo tracking without ears.
 *
 * Three parts, matching the real setup:
 *
 *   metronome1 - the source of truth the musician is playing to
 *   human      - a clumsy, intermittent tapper following metronome1
 *   metronome2 - the beat grid the tracker infers from those taps
 *
 * Success is metronome2's beats landing on metronome1's beats. Everything here
 * is deterministic: the tapper's jitter comes from a seeded generator, so a
 * scenario produces byte-identical taps on every run.
 */

import { TempoTracker, type TempoTrackerOptions } from "./tempo-tracker";

/** Seeded PRNG (mulberry32). Small, fast, and good enough for jitter. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Normally distributed sample, via Box-Muller. */
export function gaussian(next: () => number, sigma: number): number {
	const u = Math.max(next(), Number.EPSILON);
	const v = next();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
}

/** Tempo in BPM as a function of elapsed milliseconds. */
export type TempoCurve = (elapsedMs: number) => number;

export const constantTempo =
	(bpm: number): TempoCurve =>
	() =>
		bpm;

/** Linear drift, e.g. `ramp(100, 1 / 45)` for +1 BPM every 45 seconds. */
export const ramp =
	(bpm: number, bpmPerSecond: number): TempoCurve =>
	(ms) =>
		bpm + bpmPerSecond * (ms / 1000);

/** An abrupt change, as when a band drops into a new section. */
export const jump =
	(before: number, after: number, atSeconds: number): TempoCurve =>
	(ms) =>
		ms < atSeconds * 1000 ? before : after;

/** Speeds up, then holds - the classic live-band rush into a chorus. */
export const rushThenHold =
	(bpm: number, to: number, overSeconds: number): TempoCurve =>
	(ms) => {
		const p = Math.min(1, ms / (overSeconds * 1000));
		return bpm + (to - bpm) * p;
	};

/** Human-ish wander: a random walk around a nominal tempo. */
export function wander(bpm: number, sigma: number, seed: number): TempoCurve {
	const next = rng(seed);
	const cache = new Map<number, number>();
	let current = bpm;
	let upto = -1;
	return (ms) => {
		// Quantise to 1s steps so the curve is a pure function of time.
		// Clamp negative pre-roll times to step 0 so pre-start queries return a valid number.
		const step = Math.max(0, Math.floor(ms / 1000));
		if (cache.has(step)) return cache.get(step) as number;
		while (upto < step) {
			upto += 1;
			current += gaussian(next, sigma);
			cache.set(upto, current);
		}
		return cache.get(step) as number;
	};
}

/** Beat times for metronome1, in milliseconds from zero. */
export function metronome1(tempo: TempoCurve, beats: number): number[] {
	const out: number[] = [];
	let t = 0;
	for (let i = 0; i < beats; i++) {
		out.push(t);
		t += 60000 / tempo(t);
	}
	return out;
}

// --- what the human chooses to tap -----------------------------------------

/** A run of consecutive beats. */
export const burst = (from: number, count: number): number[] =>
	Array.from({ length: count }, (_, i) => from + i);

/** Every `step` beats between `from` and `to`. */
export const every = (from: number, to: number, step: number): number[] => {
	const out: number[] = [];
	for (let i = from; i < to; i += step) out.push(i);
	return out;
};

/** Merge tap plans, removing duplicates and sorting. */
export const plan = (...groups: number[][]): number[] =>
	[...new Set(groups.flat())].sort((a, b) => a - b);

export interface HumanOptions {
	/** Standard deviation of tap timing error. 15-25ms is typical. */
	jitterMs?: number;
	/**
	 * Systematic offset. Real tappers anticipate a beat they are following, so a
	 * small negative value (tapping early) is the realistic default.
	 */
	leadMs?: number;
	/** Chance per tap of a gross mistiming - a fumble, not jitter. */
	fumbleChance?: number;
	/** How far a fumble lands from the beat. */
	fumbleMs?: number;
	seed?: number;
}

/** Turn a plan of beat indices into the timestamps a clumsy human produces. */
export function human(
	beats: number[],
	tapAtBeats: number[],
	options: HumanOptions = {},
): number[] {
	const {
		jitterMs = 19,
		leadMs = 0,
		fumbleChance = 0,
		fumbleMs = 90,
		seed = 1,
	} = options;
	const next = rng(seed);
	const out: number[] = [];
	for (const index of tapAtBeats) {
		if (index < 0 || index >= beats.length) continue;
		let t = beats[index] + leadMs + gaussian(next, jitterMs);
		if (fumbleChance > 0 && next() < fumbleChance) {
			t += (next() < 0.5 ? -1 : 1) * fumbleMs;
		}
		out.push(t);
	}
	return out.sort((a, b) => a - b);
}

// --- scoring metronome2 against metronome1 ---------------------------------

export interface Report {
	/** Absolute error, in ms, between metronome2's grid and each true beat. */
	medianMs: number;
	p95Ms: number;
	maxMs: number;
	/** Share of evaluated beats landing within 20ms - roughly "sounds together". */
	within20: number;
	/** Beats that were scored (those after the grid first locked). */
	scored: number;
	/** Beats where no grid existed at all. */
	unlocked: number;
	/** Final inferred tempo, for readability in failures. */
	finalBpm: number | null;
	errors: number[];
}

export interface RunOptions extends TempoTrackerOptions {
	/** Ignore this many beats after the first tap while the grid settles. */
	warmupBeats?: number;
	/** Only score beats from this index onward. */
	fromBeat?: number;
}

/**
 * Replay a scenario in time order and score it.
 *
 * Taps are fed to the tracker as they occur, and every metronome1 beat is
 * compared against whatever grid the tracker had produced by that instant - so
 * the tracker is never scored on information it could not yet have had.
 */
export function runScenario(
	beats: number[],
	taps: number[],
	options: RunOptions = {},
): Report {
	const { warmupBeats = 8, fromBeat = 0, ...trackerOptions } = options;
	const tracker = new TempoTracker(trackerOptions);

	const firstTap = taps.length ? taps[0] : Number.POSITIVE_INFINITY;
	const errors: number[] = [];
	let unlocked = 0;
	let cursor = 0;

	for (let i = 0; i < beats.length; i++) {
		const beatTime = beats[i];
		// Feed every tap that happened before this beat.
		while (cursor < taps.length && taps[cursor] <= beatTime) {
			tracker.addTap(taps[cursor]);
			cursor++;
		}
		if (beatTime < firstTap) continue;
		if (i < fromBeat) continue;
		const grid = tracker.current();
		if (!grid) {
			unlocked++;
			continue;
		}
		if (grid.tapCount < 2) continue;
		// Skip the settling period measured from the first tap.
		if (beats[i] - firstTap < warmupBeats * grid.periodMs) continue;
		const err = tracker.errorAt(beatTime);
		if (err !== null) errors.push(Math.abs(err));
	}

	const sorted = [...errors].sort((a, b) => a - b);
	const at = (q: number) =>
		sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : Number.NaN;
	const grid = tracker.current();

	return {
		medianMs: at(0.5),
		p95Ms: at(0.95),
		maxMs: sorted.length ? sorted[sorted.length - 1] : Number.NaN,
		within20: sorted.length ? sorted.filter((e) => e <= 20).length / sorted.length : 0,
		scored: sorted.length,
		unlocked,
		finalBpm: grid ? 60000 / grid.periodMs : null,
		errors,
	};
}
