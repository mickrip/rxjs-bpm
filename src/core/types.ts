export type EngineState = "idle" | "collecting" | "locked";

export interface TempoReading {
	/** Stable, quantized output. `null` until the engine has locked once. */
	bpm: number | null;
	/** Unsmoothed instantaneous estimate — useful for UIs/debugging. */
	rawBpm: number | null;
	/** 0..1 — how much to trust `bpm` right now. */
	confidence: number;
	state: EngineState;
	/** Accepted taps in the current measurement session. */
	tapCount: number;
	/** True iff `bpm` differs from the previous reading. */
	changed: boolean;
}

export interface TapTempoOptions {
	/** Absolute debounce floor in ms — rejects switch bounce. */
	refractoryMinMs: number;
	/** Adaptive debounce: taps closer than this fraction of a beat are dropped. */
	refractoryBeatFraction: number;
	/** A gap longer than this many beats starts a new measurement session. */
	sessionTimeoutBeats: number;
	/** Session-gap fallback in ms, used before any tempo estimate exists. */
	sessionTimeoutMs: number;
	/** Number of inter-tap intervals kept in the sliding window. */
	windowSize: number;
	/** Matching band for octave folding (missed taps / double taps). */
	foldTolerance: number;
	/** Median-deviation band; intervals outside it are excluded from the average. */
	outlierTolerance: number;
	/** Intervals needed before the engine can lock. */
	minTaps: number;
	/** Max coefficient of variation (stddev/mean) of the window to lock. */
	lockCvMax: number;
	/**
	 * Max relative standard error (cv/√n) before the first report. Makes
	 * lock time adapt to the player: clean tapping locks at minTaps, sloppy
	 * tapping needs more taps (capped at a full window).
	 */
	lockSeMax: number;
	/** Dead band around the reported BPM; raw drift inside it is ignored. */
	hysteresisBpm: number;
	/** Consecutive out-of-band estimates required to re-latch the report. */
	confirmTaps: number;
	/**
	 * In-band drift correction: consecutive taps for which the quantized
	 * raw estimate must agree on the SAME alternative value before the
	 * report adopts it. Fixes the small settle error a re-latch can leave.
	 */
	driftTaps: number;
	/** Output grid in BPM (e.g. 0.5). Set 0 to disable quantization. */
	quantizeBpm: number;
	/** Optional sanity range — estimates fold (halve/double) into range. */
	minBpm?: number;
	maxBpm?: number;
}

export const DEFAULT_OPTIONS: TapTempoOptions = {
	refractoryMinMs: 100,
	refractoryBeatFraction: 0.4,
	sessionTimeoutBeats: 2.5,
	sessionTimeoutMs: 2000,
	windowSize: 16,
	foldTolerance: 0.15,
	outlierTolerance: 0.12,
	minTaps: 4,
	lockCvMax: 0.1,
	lockSeMax: 0.015,
	hysteresisBpm: 1.5,
	confirmTaps: 3,
	driftTaps: 6,
	quantizeBpm: 0.5,
};
