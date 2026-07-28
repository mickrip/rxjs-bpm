import {
	DEFAULT_OPTIONS,
	type EngineState,
	type TapTempoOptions,
	type TempoReading,
} from "./types";

interface IntervalSample {
	/** Interval normalized to one beat (folded if needed), in ms. */
	value: number;
	/** The actual gap between the two accepted taps, in ms. */
	gapMs: number;
	/** How many beats that gap spans (0.5 = double tap, 2 = missed tap). */
	beats: number;
	folded: boolean;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp01(x: number): number {
	return Math.min(1, Math.max(0, x));
}

/**
 * Emitter-agnostic tap-tempo core. The only input is `tap(timestampMs)`;
 * time is always supplied by the caller, so the engine is fully deterministic.
 */
export class TapTempoEngine {
	private readonly opts: TapTempoOptions;
	private window: IntervalSample[] = [];
	private lastTapAt: number | null = null;
	private state: EngineState = "idle";
	private tapCount = 0;
	private rawBpm: number | null = null;
	private preciseBpm: number | null = null;
	private reportedBpm: number | null = null;
	private outOfBandCount = 0;
	private driftCandidate: number | null = null;
	private driftCount = 0;
	private lastCv = Number.POSITIVE_INFINITY;
	private lastKeptCount = 0;
	// Confidence carried across a session reset while the tempo is held.
	private heldConfidenceBase = 0;

	constructor(options: Partial<TapTempoOptions> = {}) {
		this.opts = { ...DEFAULT_OPTIONS, ...options };
	}

	tap(timestampMs: number): TempoReading {
		const o = this.opts;

		// Stage 0 — drop non-finite and non-monotonic timestamps.
		if (!Number.isFinite(timestampMs)) return this.buildReading(false);
		if (this.lastTapAt !== null && timestampMs <= this.lastTapAt) {
			return this.buildReading(false);
		}

		if (this.lastTapAt === null) {
			this.lastTapAt = timestampMs;
			this.tapCount = 1;
			if (this.state === "idle") this.state = "collecting";
			return this.buildReading(false);
		}

		const gap = timestampMs - this.lastTapAt;
		const beatMs = this.gatingBeatMs();

		// Stage 1 — refractory gate. The bounced tap is dropped entirely;
		// the next real beat is still measured from the last accepted tap.
		const refractory =
			beatMs !== null
				? Math.max(o.refractoryMinMs, o.refractoryBeatFraction * beatMs)
				: o.refractoryMinMs;
		if (gap < refractory) return this.buildReading(false);

		// Stage 2 — session segmentation. The held tempo survives the reset.
		// With an empty window (fresh session) the timeout is floored at the
		// absolute fallback, so a held fast tempo can't lock out a slower
		// new song by making every beat look like a timeout.
		const beatTimeout = beatMs !== null ? o.sessionTimeoutBeats * beatMs : null;
		const timeout =
			this.window.length === 0
				? Math.max(o.sessionTimeoutMs, beatTimeout ?? 0)
				: (beatTimeout ?? o.sessionTimeoutMs);
		if (gap > timeout) {
			this.window = [];
			this.tapCount = 1;
			this.lastTapAt = timestampMs;
			this.outOfBandCount = 0;
			this.driftCandidate = null;
			this.driftCount = 0;
			this.heldConfidenceBase = this.currentConfidenceBase() * 0.75;
			this.lastCv = Number.POSITIVE_INFINITY;
			this.lastKeptCount = 0;
			return this.buildReading(false);
		}

		this.lastTapAt = timestampMs;
		this.tapCount++;

		// Stage 4 — octave folding: rescue intervals that are musically
		// related to the running median (missed tap ≈ 2×, double tap ≈ ½×).
		let value = gap;
		let beats = 1;
		let folded = false;
		if (this.window.length >= 4) {
			const m = median(this.window.map((s) => s.value));
			if (Math.abs(gap / (2 * m) - 1) <= o.foldTolerance) {
				value = gap / 2;
				beats = 2;
				folded = true;
			} else if (Math.abs(gap / (m / 2) - 1) <= o.foldTolerance) {
				value = gap * 2;
				beats = 0.5;
				folded = true;
			}
		}

		// Stage 3 — sliding window.
		this.window.push({ value, gapMs: gap, beats, folded });
		if (this.window.length > o.windowSize) this.window.shift();

		// Stages 5 & 6 — robust estimates.
		this.updateEstimate();

		// Stage 8 — lock once the window is big and consistent enough.
		// The standard-error gate makes lock time adapt to the player: a
		// clean tapper locks at minTaps, a sloppy one has to earn it with
		// more taps (capped at a full window) before the first report.
		if (
			this.state !== "locked" &&
			this.window.length >= o.minTaps &&
			this.lastCv <= o.lockCvMax &&
			(this.lastCv / Math.sqrt(Math.max(1, this.lastKeptCount)) <=
				o.lockSeMax ||
				this.window.length >= o.windowSize)
		) {
			this.state = "locked";
		}
		if (this.window.length >= o.minTaps) this.heldConfidenceBase = 0;

		// Stage 7 — hysteresis latch. Detection runs on the fast tracker
		// (responsive, noisy); latched values come from the precise
		// full-window estimate (slow, telescoped — endpoint noise only).
		let changed = false;
		if (
			this.state === "locked" &&
			this.rawBpm !== null &&
			this.preciseBpm !== null &&
			this.window.length >= o.minTaps
		) {
			if (this.reportedBpm === null) {
				this.reportedBpm = this.quantize(this.preciseBpm);
				changed = true;
			} else if (Math.abs(this.rawBpm - this.reportedBpm) >= o.hysteresisBpm) {
				this.outOfBandCount++;
				this.driftCandidate = null;
				this.driftCount = 0;
				if (this.outOfBandCount >= o.confirmTaps) {
					// The fast tracker only TRIGGERS; the precise estimate
					// JUDGES. Without this, fast-tracker noise re-latches the
					// report even when the underlying tempo hasn't moved.
					if (
						Math.abs(this.preciseBpm - this.reportedBpm) >= o.hysteresisBpm
					) {
						const next = this.quantize(this.preciseBpm);
						if (next !== this.reportedBpm) {
							this.reportedBpm = next;
							changed = true;
						}
					}
					this.outOfBandCount = 0;
				}
			} else {
				this.outOfBandCount = 0;
				// Drift correction: a re-latch can settle inside the dead band
				// slightly off the true tempo. If the quantized precise
				// estimate disagrees with the report by the SAME value for
				// driftTaps consecutive taps, adopt it. Jittery input keeps
				// flipping the candidate, so this never fires on noise.
				const q = this.quantize(this.preciseBpm);
				if (q !== this.reportedBpm) {
					if (q === this.driftCandidate) {
						this.driftCount++;
					} else {
						this.driftCandidate = q;
						this.driftCount = 1;
					}
					if (this.driftCount >= o.driftTaps) {
						this.reportedBpm = q;
						changed = true;
						this.driftCandidate = null;
						this.driftCount = 0;
					}
				} else {
					this.driftCandidate = null;
					this.driftCount = 0;
				}
			}
		}

		return this.buildReading(changed);
	}

	/**
	 * Current state without registering a tap. Pass "now" to get a
	 * freshness-decayed confidence; without it freshness is assumed 1.
	 */
	reading(nowMs?: number): TempoReading {
		return this.buildReading(false, nowMs);
	}

	reset(): void {
		this.window = [];
		this.lastTapAt = null;
		this.state = "idle";
		this.tapCount = 0;
		this.rawBpm = null;
		this.preciseBpm = null;
		this.reportedBpm = null;
		this.outOfBandCount = 0;
		this.driftCandidate = null;
		this.driftCount = 0;
		this.lastCv = Number.POSITIVE_INFINITY;
		this.lastKeptCount = 0;
		this.heldConfidenceBase = 0;
	}

	private currentBeatMs(): number | null {
		const bpm = this.reportedBpm ?? this.rawBpm;
		return bpm !== null && bpm > 0 ? 60000 / bpm : null;
	}

	// Beat length used for the refractory/timeout gates. Prefers evidence
	// from the current session's window over the held report, so gating
	// follows the tempo actually being tapped right now.
	private gatingBeatMs(): number | null {
		const bpm =
			this.window.length > 0
				? (this.rawBpm ?? this.reportedBpm)
				: (this.reportedBpm ?? this.rawBpm);
		return bpm !== null && bpm > 0 ? 60000 / bpm : null;
	}

	private quantize(bpm: number): number {
		const q = this.opts.quantizeBpm;
		return q > 0 ? Math.round(bpm / q) * q : bpm;
	}

	private foldIntoRange(bpm: number): number {
		const o = this.opts;
		let out = bpm;
		if (o.maxBpm !== undefined) {
			for (let i = 0; i < 3 && out > o.maxBpm; i++) out /= 2;
		}
		if (o.minBpm !== undefined) {
			for (let i = 0; i < 3 && out < o.minBpm; i++) out *= 2;
		}
		return out;
	}

	// Stage 5 (median outlier stats) + Stage 6. Both estimators are
	// beats-per-timespan rates (Σbeats / Σgap) rather than means of
	// per-interval BPMs: consecutive gaps share tap timestamps, so summing
	// a contiguous run telescopes the jitter away — only the endpoints'
	// noise survives. That's also why the precise estimate uses the WHOLE
	// window: excluding middle samples would reintroduce endpoint noise,
	// and beat-count normalization already absorbs musical outliers.
	// Median/CV stats over the normalized values gate locking and feed
	// confidence — they no longer filter the estimate itself.
	//   rawBpm     — last ≤4 samples: responsive, used to DETECT change.
	//   preciseBpm — full window: stable, the value REPORTED.
	private updateEstimate(): void {
		const o = this.opts;
		if (this.window.length === 0) return;

		const values = this.window.map((s) => s.value);
		const m = median(values);
		const kept = this.window.filter(
			(s) => Math.abs(s.value - m) / m <= o.outlierTolerance,
		);

		if (kept.length > 0) {
			const keptValues = kept.map((s) => s.value);
			const mean =
				keptValues.reduce((acc, v) => acc + v, 0) / keptValues.length;
			const variance =
				keptValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) /
				keptValues.length;
			this.lastCv = Math.sqrt(variance) / mean;
			this.lastKeptCount = kept.length;
		} else {
			this.lastCv = Number.POSITIVE_INFINITY;
			this.lastKeptCount = 0;
		}

		const rate = (samples: IntervalSample[]): number => {
			let totalGap = 0;
			let totalBeats = 0;
			for (const s of samples) {
				totalGap += s.gapMs;
				totalBeats += s.beats;
			}
			return (60000 * totalBeats) / totalGap;
		};

		this.preciseBpm = this.foldIntoRange(rate(this.window));
		this.rawBpm = this.foldIntoRange(rate(this.window.slice(-4)));
	}

	private currentConfidenceBase(): number {
		const o = this.opts;
		if (this.window.length === 0) return this.heldConfidenceBase;
		const tapFactor = Math.min(1, this.window.length / o.windowSize);
		const consistency = Number.isFinite(this.lastCv)
			? clamp01(1 - this.lastCv / 0.15)
			: 0;
		return Math.max(tapFactor * consistency, this.heldConfidenceBase);
	}

	private freshness(nowMs?: number): number {
		if (nowMs === undefined || this.lastTapAt === null) return 1;
		const beatMs = this.currentBeatMs();
		if (beatMs === null) return 1;
		const gap = nowMs - this.lastTapAt;
		const threshold = 8 * beatMs;
		if (gap <= threshold) return 1;
		return Math.max(0.5, 1 - 0.5 * ((gap - threshold) / threshold));
	}

	private buildReading(changed: boolean, nowMs?: number): TempoReading {
		return {
			bpm: this.reportedBpm,
			rawBpm: this.rawBpm,
			confidence:
				this.state === "idle"
					? 0
					: clamp01(this.currentConfidenceBase()) * this.freshness(nowMs),
			state: this.state,
			tapCount: this.tapCount,
			changed,
		};
	}
}
