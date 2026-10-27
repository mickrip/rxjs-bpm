/**
 * Tempo tracking from sparse, jittery tap timestamps.
 *
 * The output is a *beat grid* rather than a BPM reading: two numbers that
 * describe every beat, past and future, as `anchorMs + n * periodMs`. A
 * consumer that wants to sound a metronome schedules from the grid; it never
 * needs the tracker to tell it "now".
 *
 * Three ideas do the work:
 *
 *   1. Taps are assigned to beat *numbers*, not treated as consecutive. A tap
 *      eight beats after the last one contributes a long baseline, which is far
 *      more informative about the period than eight adjacent taps would be.
 *   2. Period and phase come from a least-squares fit of tap time against beat
 *      number, so tap jitter averages out instead of accumulating.
 *   3. The amount of history to fit over is chosen by the data. Several
 *      candidate horizons are scored on how well they predict the next tap
 *      before it lands; the winner is used. After a tempo change the stale
 *      horizons mispredict badly and disqualify themselves, so the tracker
 *      falls back to recent history and then re-earns the longer memory.
 */

export interface TempoGrid {
	/** Milliseconds between beats. */
	periodMs: number;
	/** Timestamp of beat zero. Beat n falls at `anchorMs + n * periodMs`. */
	anchorMs: number;
	/** Beats of history the current estimate is drawn from. */
	horizon: number;
	/** Taps informing the current estimate. */
	tapCount: number;
}

export interface TempoTrackerOptions {
	/** Candidate history lengths, in taps. Log-spaced by default. */
	horizons?: number[];
	/**
	 * How many recent taps the phase anchor is drawn from.
	 *
	 * 1 - the default - means a tap *is* the beat: the grid moves to sit exactly
	 * on it. That is what a musician means by tapping to resync, and it recovers
	 * from any amount of drift in a single tap.
	 *
	 * Larger values take the median of that many recent taps instead, which
	 * rejects the tapper's own jitter but no longer honours a single tap: with 3,
	 * a tap 60ms from the grid moves it only about 13ms. Worth having when the
	 * tapper is playing along continuously rather than correcting.
	 */
	anchorTaps?: number;
	/** Slowest tempo accepted when bootstrapping, in BPM. */
	minBpm?: number;
	/** Fastest tempo accepted when bootstrapping, in BPM. */
	maxBpm?: number;
	/**
	 * How far a gap may sit from a whole number of beats before the beat count
	 * is treated as unknowable. 0.25 means a gap must land within a quarter of a
	 * beat of an integer to be trusted.
	 */
	ambiguity?: number;
	/** Longest gap, in beats, that will be bridged without a resync. */
	maxGapBeats?: number;
	/**
	 * How much of a beat of accumulated uncertainty is tolerated when bridging a
	 * silence. Lower is more cautious: it refuses more gaps rather than risk
	 * numbering one wrongly, which is the more damaging error.
	 */
	bridgeConfidence?: number;
	/**
	 * Consecutive unbridgeable gaps before the period itself is presumed wrong
	 * and the tracker unlocks. Without this a stale period can reject every tap
	 * that would have corrected it.
	 */
	rejectsBeforeUnlock?: number;
	/**
	 * Taps required before a tempo is published at all. Two taps imply a period
	 * with the tapper's full jitter baked in - around five per cent - and every
	 * later beat number is assigned using it, so locking that early poisons
	 * everything downstream.
	 */
	minTapsToLock?: number;
	/**
	 * How much better a shorter horizon must predict before it is preferred over
	 * a longer one. When every horizon models the data well their scores differ
	 * only by noise, and picking the shortest would throw away the long baseline
	 * that makes the period precise. A margin means length wins ties.
	 */
	shortHorizonMargin?: number;
	/**
	 * Longest silence that may be bridged, as a multiple of the history actually
	 * observed. Bridging thirty beats on the strength of five is reckless however
	 * good the arithmetic looks, because a biased period - as opposed to merely
	 * a noisy one - is not visible in the residuals at all.
	 */
	bridgeSpanFactor?: number;
	/**
	 * Taps the numbering reference is drawn from - deliberately separate from
	 * `anchorTaps`, so that snapping the output to a single tap does not make
	 * beat numbering, and through it the period, inherit that tap's jitter.
	 */
	indexAnchorTaps?: number;
	/**
	 * Consecutive tap gaps that must agree before a steady run is recognised, and
	 * how closely they must agree. A steady run is how the octave ambiguity is
	 * broken: see `steadyRun`.
	 */
	steadyRunTaps?: number;
	steadyRunTolerance?: number;
	/**
	 * How far the held period must be from dividing a steady run of taps, as a
	 * fraction of itself, before it is presumed wrong. Must clear the tapper's own
	 * jitter, or tapping once a bar reads as a tempo change every time.
	 */
	harmonicOffset?: number;
	/** Predictions kept per horizon when scoring. */
	scoreDepth?: number;
}

interface Tap {
	index: number;
	time: number;
}

const DEFAULTS = {
	horizons: [4, 8, 16, 32, 64],
	anchorTaps: 1,
	indexAnchorTaps: 3,
	steadyRunTaps: 3,
	steadyRunTolerance: 0.08,
	harmonicOffset: 0.035,
	minBpm: 30,
	maxBpm: 300,
	ambiguity: 0.35,
	maxGapBeats: 128,
	bridgeConfidence: 0.4,
	rejectsBeforeUnlock: 6,
	minTapsToLock: 4,
	shortHorizonMargin: 0.2,
	bridgeSpanFactor: 2.5,
	scoreDepth: 6,
} satisfies Required<TempoTrackerOptions>;

interface Fit {
	period: number;
	anchor: number;
	/** Standard error of the period, in ms. Infinite when unknowable. */
	periodError: number;
}

/** Least-squares fit of time against beat index. */
function fit(taps: Tap[]): Fit | null {
	const n = taps.length;
	if (n < 2) return null;
	let sumI = 0;
	let sumT = 0;
	for (const tap of taps) {
		sumI += tap.index;
		sumT += tap.time;
	}
	const meanI = sumI / n;
	const meanT = sumT / n;
	let sxx = 0;
	let sxy = 0;
	for (const tap of taps) {
		const di = tap.index - meanI;
		sxx += di * di;
		sxy += di * (tap.time - meanT);
	}
	if (sxx === 0) return null;
	const period = sxy / sxx;
	const anchor = meanT - period * meanI;

	// How precisely is the period known? This is what decides how long a silence
	// can be bridged: the uncertainty is multiplied by the number of beats in the
	// gap, and once that product approaches half a beat the count is a guess.
	let periodError = Number.POSITIVE_INFINITY;
	if (n > 2) {
		let ss = 0;
		for (const tap of taps) {
			const r = tap.time - (anchor + period * tap.index);
			ss += r * r;
		}
		periodError = Math.sqrt(ss / (n - 2) / sxx);
	}
	return { period, anchor, periodError };
}

/** Median of `t - period * index` over the last `count` taps: a robust phase. */
function medianResidual(taps: Tap[], period: number, count: number): number {
	const window = taps.slice(-Math.max(1, count));
	const residuals = window.map((tap) => tap.time - period * tap.index).sort((a, b) => a - b);
	const mid = residuals.length >> 1;
	return residuals.length % 2 === 1
		? residuals[mid]
		: (residuals[mid - 1] + residuals[mid]) / 2;
}

export class TempoTracker {
	private readonly opts: Required<TempoTrackerOptions>;
	private taps: Tap[] = [];
	private grid: TempoGrid | null = null;
	/** Recent one-step-ahead prediction errors, per candidate horizon. */
	private scores = new Map<number, number[]>();
	/** Standard error of the current period estimate, or null if unknown. */
	private periodError: number | null = null;
	/** Consecutive taps whose beat number could not be determined. */
	private rejects = 0;
	/**
	 * Whether a fresh run of agreeing taps is needed before the tempo may change.
	 * True at startup, and again whenever the held period stops explaining the
	 * taps arriving. It gates changes to the period only - never to the grid's
	 * existence, because a metronome that falls silent is worse than one that is
	 * briefly wrong.
	 */
	private needsFreshEvidence = true;
	/**
	 * Last period believed in, kept even after unlocking. A tempo that has been
	 * established once is the best guess for re-acquiring after a run of taps
	 * that could not be placed - without it, sparse taps twelve beats apart read
	 * as an implausibly slow tempo and can never re-establish anything.
	 */
	private priorPeriod: number | null = null;
	/**
	 * Beats spanned by the taps the current period was fitted over. Survives a
	 * restart, because how far a silence may be bridged depends on the evidence
	 * behind the period, not on how many taps have arrived since.
	 */
	private fittedSpan = 0;
	/**
	 * Least-squares phase, as opposed to the snapped phase the grid reports.
	 *
	 * Beat numbering has to be measured from something steady. If it were done
	 * against the published anchor, then snapping to each tap would feed that
	 * tap's jitter back into deciding which beat the *next* tap belongs to, and
	 * the period estimate would inherit the noise. But it cannot be the
	 * least-squares intercept either, which is too stale to number taps correctly
	 * once the tempo has moved. The median of the last few taps is both.
	 */
	private fitAnchor: number | null = null;
	/** Raw intervals between the last few taps, whether or not they were placed. */
	private recentGaps: number[] = [];
	/** Timestamp of the most recent non-bounce raw tap, whether or not placed. */
	private lastTapTime: number | null = null;
	/**
	 * For each recent gap, how far it sat from a whole number of beats at the
	 * moment it arrived, in beats. Judged then and remembered, because the period
	 * slides towards the harmonic over the next few taps: by the time a steady run
	 * is confirmed, 706ms against a period that has drifted to 353 is exactly two
	 * beats, and the evidence of a change has been erased.
	 */
	private recentOffBy: number[] = [];

	constructor(options: TempoTrackerOptions = {}) {
		const horizons =
			options.horizons && options.horizons.length > 0
				? [...new Set(options.horizons)].sort((a, b) => a - b)
				: [...DEFAULTS.horizons];
		this.opts = { ...DEFAULTS, ...options, horizons };
		for (const h of this.opts.horizons) this.scores.set(h, []);
	}

	/** The current beat grid, or null while there is too little to go on. */
	current(): TempoGrid | null {
		return this.grid;
	}

	/** Timestamp of the beat nearest `time` according to the current grid. */
	nearestBeat(time: number): number | null {
		if (!this.grid) return null;
		const { anchorMs, periodMs } = this.grid;
		return anchorMs + Math.round((time - anchorMs) / periodMs) * periodMs;
	}

	/** Signed error, in ms, between the grid's nearest beat and `time`. */
	errorAt(time: number): number | null {
		const beat = this.nearestBeat(time);
		return beat === null ? null : beat - time;
	}

	/** Discard all history. The next taps bootstrap a fresh grid. */
	reset(): void {
		this.taps = [];
		this.grid = null;
		this.periodError = null;
		this.priorPeriod = null;
		this.fittedSpan = 0;
		this.fitAnchor = null;
		this.recentGaps = [];
		this.lastTapTime = null;
		this.recentOffBy = [];
		this.rejects = 0;
		this.needsFreshEvidence = true;
		for (const h of this.opts.horizons) this.scores.set(h, []);
	}

	/**
	 * Record a tap. Timestamps must be non-decreasing and share one clock —
	 * `performance.now()`, a MIDI event's `timeStamp`, or a captured fixture.
	 */
	addTap(time: number): void {
		let previous = this.taps.at(-1);

		if (!previous) {
			this.taps.push({ index: 0, time });
			this.lastTapTime = time;
			return;
		}

		const prevRawTime = this.lastTapTime ?? previous.time;

		// A tap on top of the previous one carries no timing information at all.
		if (time <= prevRawTime || time <= previous.time) return;

		const rawGap = time - prevRawTime;
		// Faster than anyone can tap: a hardware bounce or double-trigger.
		if (60000 / rawGap > this.opts.maxBpm) return;

		this.lastTapTime = time;
		this.recentGaps.push(rawGap);
		this.recentOffBy.push(this.periodDiscrepancy(rawGap));
		if (this.recentGaps.length > this.opts.steadyRunTaps * 2) {
			this.recentGaps.shift();
			this.recentOffBy.shift();
		}

		const steady = this.steadyRun();
		const bpm = steady === null ? 0 : 60000 / steady;
		const plausible = bpm >= this.opts.minBpm && bpm <= this.opts.maxBpm;
		// The largest discrepancy in the run, not the average. The period slides
		// towards the harmonic within a tap or two of the change, so only the first
		// gap of the run is judged against an unpolluted period; averaging would
		// dilute that one clear reading with the compromised ones after it.
		const worst = Math.max(...this.recentOffBy.slice(-this.opts.steadyRunTaps), 0);
		const sawContradiction = worst > this.opts.harmonicOffset;
		if (!this.needsFreshEvidence && steady !== null && plausible && sawContradiction) {
			// The taps are telling us plainly what the beat is, and it is not what we
			// are holding. Drop the old period entirely - keeping it as a prior would
			// only let the re-acquiring path find the same wrong multiple again - and
			// rebuild from these taps as consecutive beats.
			this.needsFreshEvidence = true;
			this.priorPeriod = null;
			this.periodError = null;
			this.recentOffBy = this.recentOffBy.map(() => 0);
			this.beginAt(prevRawTime);
			previous = this.taps[0];
		}

		const index = this.assignIndex(previous, time);
		if (index === "ignore") return;
		if (index === null) {
			// The tap could not be numbered. What that means depends on how long the
			// gap was. After a real silence it is a new position, and re-anchoring
			// there is what lets one tap re-align the grid. But a tap landing a third
			// of a beat off, moments after the last one, is simply a bad tap:
			// re-anchoring on it would make the stray the reference every later tap
			// is judged against, and a single fumble would cascade.
			const afterSilence =
				this.grid === null || time - previous.time >= this.grid.periodMs * 2;
			this.reject(time, afterSilence);
			return;
		}

		this.rejects = 0;
		this.scoreHorizons(index, time);
		this.taps.push({ index, time });
		this.rebuild();
	}

	/**
	 * The interval of a steady run of taps, if the last few gaps agree.
	 *
	 * Someone tapping evenly is tapping *the beat* - that is what tap tempo
	 * means. So when consecutive gaps agree, that gap is the period, and not a
	 * multiple of one. Without this the tracker cannot tell 85 tapped on every
	 * beat from 170 tapped on every other, and it will always prefer whichever
	 * is nearer the tempo it already holds - so a drop to 85 while holding 160
	 * settles confidently on 170.
	 */
	private steadyRun(): number | null {
		const gaps = this.recentGaps.slice(-this.opts.steadyRunTaps);
		if (gaps.length < this.opts.steadyRunTaps) return null;
		const sorted = [...gaps].sort((a, b) => a - b);
		const median = sorted[sorted.length >> 1];
		if (median <= 0) return null;
		for (const g of gaps) {
			if (Math.abs(g / median - 1) > this.opts.steadyRunTolerance) return null;
		}
		return median;
	}

	/**
	 * How badly the held period fails to divide a gap, as a fraction of itself.
	 *
	 * Expressed as a period discrepancy rather than a beat one, because a beat
	 * discrepancy grows with the number of beats in the gap: tapping once a bar
	 * strays four times as far as tapping every beat, for the same accuracy. This
	 * measure does not, so one threshold serves every tapping density.
	 */
	private periodDiscrepancy(gap: number): number {
		if (!this.grid || this.needsFreshEvidence) return 0;
		const held = this.grid.periodMs;
		const beats = Math.round(gap / held);
		if (beats < 1) return 0;
		if (beats === 1) {
			const diff = Math.abs(held - gap) / held;
			return diff > this.opts.steadyRunTolerance ? diff : 0;
		}
		return Math.abs(held - gap / beats) / held;
	}

	private clearScores(): void {
		for (const h of this.opts.horizons) this.scores.set(h, []);
	}

	/** Begin numbering afresh at `time`, keeping the tempo currently being sounded. */
	private beginAt(time: number): void {
		this.taps = [{ index: 0, time }];
		this.clearScores();
		// This tap becomes beat zero, so the numbering reference moves with it.
		// Leaving it behind would number later taps against a phase nothing refers
		// to any more.
		this.fitAnchor = time;
	}

	/**
	 * Handle a tap that could not be placed. `canReanchor` says whether the tap is
	 * trustworthy enough to become the new beat zero - which a tap after a silence
	 * is, and a stray mid-beat tap is not.
	 */
	private reject(time: number, canReanchor: boolean): void {
		this.rejects += 1;
		if (this.rejects >= this.opts.rejectsBeforeUnlock) {
			// Taps keep failing to fit the period being held, so the period is the
			// thing that is wrong. Keep sounding it - the beat must not stop - but
			// start gathering a replacement from scratch, beginning with this tap.
			this.needsFreshEvidence = true;
			this.periodError = null;
			this.rejects = 0;
			this.beginAt(time);
			if (canReanchor && this.grid) {
				this.grid = { ...this.grid, anchorMs: time, tapCount: 1 };
			}
			return;
		}
		if (!canReanchor) return;
		this.beginAt(time);
		if (this.grid) this.grid = { ...this.grid, anchorMs: time, tapCount: 1 };
	}

	/**
	 * Work out which beat number a tap belongs to. Without a grid the tap is
	 * assumed to be the next beat; with one, its offset from the grid is rounded
	 * to the nearest whole number of beats and rejected if it does not land close
	 * enough to one.
	 */
	private assignIndex(previous: Tap, time: number): number | null | "ignore" {
		// While fresh evidence is being gathered, taps are numbered as consecutive
		// beats rather than against the grid. The grid carries on sounding, but it
		// must not also be the yardstick for the taps trying to replace it - a held
		// 120 rejects every tap of an 84 as unplaceable, and the tempo could then
		// never change at all.
		if (!this.grid || this.needsFreshEvidence) {
			const gap = time - previous.time;
			// Re-acquiring: if a tempo was known before, see whether this gap is a
			// whole number of beats at that tempo. That is what lets an occasional
			// tap resume a tempo it already knew, rather than needing a fresh burst.
			if (this.priorPeriod !== null) {
				const beats = gap / this.priorPeriod;
				const whole = Math.round(beats);
				// Held to a tighter tolerance than normal indexing: re-acquiring on a
				// wrong beat count locks in a plausible, self-consistent, wrong tempo
				// that nothing later will contradict.
				if (
					whole >= 1 &&
					whole <= this.opts.maxGapBeats &&
					Math.abs(beats - whole) <= this.opts.ambiguity * 0.45
				) {
					return previous.index + whole;
				}
			}
			const bpm = 60000 / gap;
			// Faster than anyone can tap: a bounce or a double-trigger. Carries no
			// information, so drop it without treating it as a failed bridge.
			if (bpm > this.opts.maxBpm) return "ignore";
			// Slower than the plausible range is more likely a pause than a beat, and
			// with no tempo to count against there is no way to say how long it was.
			if (bpm < this.opts.minBpm) return null;
			return previous.index + 1;
		}

		// Number the tap against the grid rather than against the tap before it.
		// Chaining off the previous tap lets one fumble poison every comparison
		// that follows, because the fumble becomes the reference point; the grid is
		// a far steadier thing to measure against.
		const reference = this.fitAnchor ?? this.grid.anchorMs;
		const beats = (time - reference) / this.grid.periodMs;
		const whole = Math.round(beats);
		if (Math.abs(beats - whole) > this.opts.ambiguity) return null;
		// Two taps on one beat - a double-tap or a switch bounce - carry no timing
		// information. Discard the tap, but distinguish that from a gap that could
		// not be bridged: a bounce is no evidence at all about the tempo, and must
		// not count towards concluding that the tempo has changed.
		if (whole <= previous.index) return "ignore";

		const span = whole - previous.index;
		if (span > this.opts.maxGapBeats) return null;

		// A gap of more than a beat or two is only bridgeable if the period is known
		// well enough that the beat count cannot be off by one. Uncertainty in the
		// period compounds across the gap, so the longer the silence the more
		// precisely the tempo must already be known. Short gaps skip this test:
		// there, a poor fit is evidence the tempo has changed, and refusing the tap
		// would prevent the tracker from ever noticing.
		if (span > 2) {
			const spanLimit = Math.max(4, this.fittedSpan * this.opts.bridgeSpanFactor);
			if (span > spanLimit) return null;
			if (this.periodError !== null) {
				const bridgeable =
					this.opts.bridgeConfidence / (this.periodError / this.grid.periodMs);
				if (span > bridgeable) return null;
			}
		}
		return whole;
	}

	/**
	 * Before folding a tap in, ask every candidate horizon where it expected the
	 * tap to fall. Horizons fitted to a tempo that no longer holds mispredict by
	 * far more than tap jitter can explain, which is what lets a stale horizon
	 * lose to a short one immediately after a tempo change.
	 */
	private scoreHorizons(index: number, time: number): void {
		for (const h of this.opts.horizons) {
			const window = this.taps.slice(-h);
			if (window.length < 3) continue;
			const f = fit(window);
			if (!f) continue;
			const predicted = f.anchor + f.period * index;
			const errors = this.scores.get(h) as number[];
			errors.push(Math.abs(predicted - time));
			if (errors.length > this.opts.scoreDepth) errors.shift();
		}
	}

	/** Choose a horizon on recent predictive skill and rebuild the grid. */
	private rebuild(): void {
		const longest = this.opts.horizons[this.opts.horizons.length - 1];
		if (this.taps.length > longest) {
			this.taps = this.taps.slice(-longest);
		}

		const rmsByHorizon = new Map<number, number>();
		let bestScore = Number.POSITIVE_INFINITY;
		for (const h of this.opts.horizons) {
			const errors = this.scores.get(h) as number[];
			if (errors.length < 3) continue;
			let sum = 0;
			for (const e of errors) sum += e * e;
			const rms = Math.sqrt(sum / errors.length);
			rmsByHorizon.set(h, rms);
			if (rms < bestScore) bestScore = rms;
		}
		// Take the longest horizon that predicts about as well as the best one.
		// A shorter horizon is only worth having when it is clearly better, which
		// is what happens after a tempo change and almost never otherwise.
		let best: number | null = null;
		const cutoff = bestScore * (1 + this.opts.shortHorizonMargin);
		for (const h of this.opts.horizons) {
			const rms = rmsByHorizon.get(h);
			if (rms !== undefined && rms <= cutoff) best = h;
		}
		// Until enough predictions have accumulated to compare horizons, use
		// everything available.
		const horizon = best ?? longest;

		const window = this.taps.slice(-horizon);
		const f = fit(window);
		if (!f) return;

		const period = f.period;
		if (period <= 0) return;
		const bpm = 60000 / period;
		if (bpm < this.opts.minBpm || bpm > this.opts.maxBpm) return;

		// Phase comes from the most recent taps only, so that a correction lands
		// immediately rather than being averaged against older, staler taps. At the
		// default of one tap this means the grid moves to sit exactly on the tap:
		// the tap is taken to *be* the beat.
		const anchor = medianResidual(this.taps, period, this.opts.anchorTaps);

		// Not enough agreement yet to state a tempo, or to replace the one being
		// held. Where a tempo is already playing, keep it and move only its phase,
		// so a tap still re-aligns the beat while the tempo itself settles.
		if (this.needsFreshEvidence && window.length < this.opts.minTapsToLock) {
			if (this.grid) {
				const held = this.grid.periodMs;
				this.fitAnchor = medianResidual(this.taps, held, this.opts.indexAnchorTaps);
				this.grid = {
					...this.grid,
					anchorMs: medianResidual(this.taps, held, this.opts.anchorTaps),
					tapCount: window.length,
				};
			}
			return;
		}
		// Two taps separated by a bridged gap imply a period only via the beat count
		// guessed for that gap, and a wrong guess yields a tempo that is a neat
		// fraction of the truth - three beats read where two were played gives a
		// tempo half again too fast, and every later tap agrees with it. Such a fit
		// may move the phase but must not set the tempo.
		const spanOfWindow = (window.at(-1)?.index ?? 0) - (window[0]?.index ?? 0);
		if (window.length < 3 && spanOfWindow > 1 && this.grid) {
			const held = this.grid.periodMs;
			this.fitAnchor = medianResidual(this.taps, held, this.opts.indexAnchorTaps);
			this.grid = {
				...this.grid,
				anchorMs: medianResidual(this.taps, held, this.opts.anchorTaps),
				tapCount: window.length,
			};
			return;
		}
		this.needsFreshEvidence = false;

		this.periodError = Number.isFinite(f.periodError) ? f.periodError : null;
		this.priorPeriod = period;
		this.fitAnchor = medianResidual(this.taps, period, this.opts.indexAnchorTaps);
		this.fittedSpan = (window.at(-1)?.index ?? 0) - (window[0]?.index ?? 0);
		this.grid = {
			periodMs: period,
			anchorMs: anchor,
			horizon,
			tapCount: window.length,
		};
	}
}

/** Convenience: run a whole array of tap timestamps through a fresh tracker. */
export function trackTaps(
	timestamps: number[],
	options?: TempoTrackerOptions,
): TempoGrid | null {
	const tracker = new TempoTracker(options);
	for (const t of timestamps) tracker.addTap(t);
	return tracker.current();
}
