/**
 * Deterministic human tap simulator. All randomness is seeded, so every
 * test run sees the exact same "human" — no flakiness, no fake timers.
 */

/** mulberry32 — tiny seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Standard normal via Box-Muller. */
export function gaussian(rng: () => number): number {
	let u = 0;
	while (u === 0) u = rng();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export interface HumanTapsOptions {
	bpm: number;
	taps: number;
	/**
	 * Std-dev of per-tap timing error as a fraction of the beat.
	 * ~0.03 is a decent player on a foot switch; 0 is a machine.
	 */
	jitterPct?: number;
	seed?: number;
	startAt?: number;
}

/**
 * Timestamps of a human tapping along to a band. Jitter is applied around
 * the musical grid, NOT accumulated tap-to-tap: a player following a
 * drummer corrects toward the beat, so errors don't random-walk.
 */
export function humanTaps({
	bpm,
	taps,
	jitterPct = 0.03,
	seed = 1,
	startAt = 0,
}: HumanTapsOptions): number[] {
	const beat = 60000 / bpm;
	const rng = mulberry32(seed);
	return Array.from(
		{ length: taps },
		(_, i) => startAt + i * beat + gaussian(rng) * jitterPct * beat,
	);
}

/** Remove the tap at `index` — the player missed a beat. */
export function dropTap(taps: number[], index: number): number[] {
	return taps.filter((_, i) => i !== index);
}

/** Insert a spurious extra tap `offsetMs` after the tap at `index`. */
export function addGhostTap(
	taps: number[],
	index: number,
	offsetMs: number,
): number[] {
	const out = [...taps];
	out.splice(index + 1, 0, taps[index] + offsetMs);
	return out;
}

/** Feed a timestamp array through anything with a tap(t) method. */
export function feed<R>(
	engine: { tap(t: number): R },
	timestamps: number[],
): R[] {
	return timestamps.map((t) => engine.tap(t));
}
