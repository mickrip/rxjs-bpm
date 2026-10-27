import { describe, expect, it } from "vitest";
import {
	burst,
	constantTempo,
	every,
	human,
	jump,
	metronome1,
	plan,
	ramp,
	type Report,
	runScenario,
	rushThenHold,
	wander,
} from "./simulate";
import { TempoTracker, trackTaps } from "./tempo-tracker";

/**
 * Every test here is the same experiment: metronome1 plays, a clumsy human taps
 * along some of the time, and metronome2 - the tracker's beat grid - is scored
 * against metronome1 beat by beat.
 *
 * The numbers asserted are not aspirations. They are what this implementation
 * measurably achieves, with a little headroom, so that a regression fails and a
 * genuine improvement can be tightened deliberately. Roughly 20ms is the point
 * at which two clicks stop sounding like one, so `within20` - the share of
 * beats landing inside that - is the metric closest to "sounds together".
 */

interface Limits {
	median?: number;
	p95?: number;
	max?: number;
	within20?: number;
	bpm?: [number, number];
}

function check(report: Report, limits: Limits): void {
	const detail =
		`median ${report.medianMs.toFixed(1)}ms, p95 ${report.p95Ms.toFixed(1)}ms, ` +
		`max ${report.maxMs.toFixed(1)}ms, within20 ${(report.within20 * 100).toFixed(0)}%, ` +
		`final ${report.finalBpm?.toFixed(2) ?? "unlocked"} bpm, ${report.scored} beats scored`;
	expect(report.scored, `no beats were scored - ${detail}`).toBeGreaterThan(0);
	if (limits.median !== undefined) expect(report.medianMs, detail).toBeLessThan(limits.median);
	if (limits.p95 !== undefined) expect(report.p95Ms, detail).toBeLessThan(limits.p95);
	if (limits.max !== undefined) expect(report.maxMs, detail).toBeLessThan(limits.max);
	if (limits.within20 !== undefined)
		expect(report.within20, detail).toBeGreaterThanOrEqual(limits.within20);
	if (limits.bpm) {
		expect(report.finalBpm, detail).not.toBeNull();
		expect(report.finalBpm as number, detail).toBeGreaterThan(limits.bpm[0]);
		expect(report.finalBpm as number, detail).toBeLessThan(limits.bpm[1]);
	}
}

/** A musician's correction: a few taps together, not one lone tap. */
const corrections = (from: number, to: number, spacing: number, size = 3): number[] =>
	every(from, to, spacing).flatMap((b) => burst(b, size));

describe("what the human is doing", () => {
	it("says nothing at all from a single tap", () => {
		expect(trackTaps([1000])).toBeNull();
	});

	it("says nothing from two taps - they may be coincidence", () => {
		expect(trackTaps([1000, 1500])).toBeNull();
	});

	it("says nothing from three taps - a tempo needs corroborating", () => {
		expect(trackTaps([1000, 1500, 2000])).toBeNull();
	});

	it("takes a tap to BE the beat, moving the grid onto it exactly", () => {
		// The central promise: however far the grid has drifted, one tap puts it
		// back. Averaging recent taps instead would honour a correction only
		// partly - at a median of three, a tap 60ms out moves the grid just 13ms.
		const tracker = new TempoTracker();
		for (const t of [0, 500, 1000, 1500, 2000, 2500]) tracker.addTap(t);
		tracker.addTap(3060); // meant as a beat, landing 60ms after the grid's
		const grid = tracker.current() as { periodMs: number; anchorMs: number };
		const beatNearTap =
			grid.anchorMs + Math.round((3060 - grid.anchorMs) / grid.periodMs) * grid.periodMs;
		expect(beatNearTap).toBeCloseTo(3060, 6);
		// The tempo barely moves: a late tap is mostly a statement about where the
		// beat is. It does tug the fit a little, since it is still one of the taps
		// the period is drawn from - about a bpm and a half here, not a new tempo.
		expect(Math.abs(60000 / grid.periodMs - 120)).toBeLessThan(2.5);
	});

	it("still averages taps when asked to, for continuous tapping", () => {
		const tracker = new TempoTracker({ anchorTaps: 3 });
		for (const t of [0, 500, 1000, 1500, 2000, 2500]) tracker.addTap(t);
		tracker.addTap(3060);
		const grid = tracker.current() as { periodMs: number; anchorMs: number };
		const beatNearTap =
			grid.anchorMs + Math.round((3060 - grid.anchorMs) / grid.periodMs) * grid.periodMs;
		expect(Math.abs(beatNearTap - 3060)).toBeGreaterThan(30);
	});

	it("commits to a tempo once four taps agree", () => {
		const grid = trackTaps([1000, 1500, 2000, 2500]);
		expect(grid).not.toBeNull();
		expect(60000 / (grid as { periodMs: number }).periodMs).toBeCloseTo(120, 0);
	});

	it("ignores a repeated timestamp rather than dividing by zero", () => {
		const grid = trackTaps([0, 500, 500, 1000, 1500, 2000]);
		expect(grid).not.toBeNull();
		expect(60000 / (grid as { periodMs: number }).periodMs).toBeCloseTo(120, 0);
	});

	it("refuses a tempo faster than a human could be tapping", () => {
		expect(trackTaps([0, 50, 100, 150, 200])).toBeNull();
	});

	it("refuses a tempo slower than the plausible range", () => {
		expect(trackTaps([0, 3000, 6000, 9000])).toBeNull();
	});
});

describe("steady tempo, realistic tapping", () => {
	it("holds 120 through an opening burst and occasional corrections", () => {
		const beats = metronome1(constantTempo(120), 240);
		const taps = human(beats, plan(burst(0, 6), corrections(16, 240, 16)), { seed: 3 });
		check(runScenario(beats, taps), {
			median: 21,
			p95: 66,
			within20: 0.58,
			bpm: [119.5, 120.5],
		});
	});

	it("handles mick's bar 1 / 3 / 6 / 10 pattern", () => {
		const beats = metronome1(constantTempo(120), 120);
		const taps = human(beats, plan(burst(0, 5), [8], [20], burst(36, 5)), { seed: 4 });
		check(runScenario(beats, taps), {
			median: 8,
			p95: 25,
			within20: 0.85,
			bpm: [119, 121],
		});
	});

	it("tracks a slow ballad at 62 bpm", () => {
		const beats = metronome1(constantTempo(62), 120);
		const taps = human(beats, plan(burst(0, 6), corrections(12, 120, 12)), { seed: 10 });
		check(runScenario(beats, taps), { median: 17, p95: 62, bpm: [61, 63] });
	});

	it("tracks a fast 176 bpm", () => {
		const beats = metronome1(constantTempo(176), 320);
		const taps = human(beats, plan(burst(0, 6), corrections(16, 320, 16)), { seed: 11 });
		check(runScenario(beats, taps), { median: 20, p95: 34, within20: 0.66, bpm: [175, 177] });
	});

	it("stays locked across a five minute piece", () => {
		const beats = metronome1(constantTempo(108), 540);
		const taps = human(beats, plan(burst(0, 6), corrections(16, 540, 16)), { seed: 21 });
		check(runScenario(beats, taps), { median: 21, p95: 38, within20: 0.66, bpm: [107, 109] });
	});

	it("does not guess a tempo across a silence too long to bridge", () => {
		// Thirty-two bars of rest is far past what the period is known well enough
		// to count through, so the beat number of the tap that follows is a guess.
		// The requirement is only that it never becomes confidently wrong.
		const beats = metronome1(constantTempo(120), 200);
		const taps = human(beats, plan(burst(0, 8), [64], burst(120, 4)), { seed: 22 });
		const report = runScenario(beats, taps);
		if (report.finalBpm !== null) {
			expect(Math.abs(report.finalBpm - 120)).toBeLessThan(6);
		}
	});

	it("improves as corrections accumulate rather than drifting", () => {
		const beats = metronome1(constantTempo(120), 400);
		const taps = human(beats, plan(burst(0, 6), corrections(16, 400, 16)), { seed: 23 });
		const report = runScenario(beats, taps);
		const half = Math.floor(report.errors.length / 2);
		const early = report.errors.slice(0, half);
		const late = report.errors.slice(half);
		const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
		expect(mean(late)).toBeLessThanOrEqual(mean(early) * 1.2);
	});

	it("tapping every bar keeps it tight", () => {
		const beats = metronome1(constantTempo(120), 240);
		const taps = human(beats, plan(burst(0, 4), every(4, 240, 4)), { seed: 24 });
		check(runScenario(beats, taps), { median: 18, p95: 42, within20: 0.66, bpm: [119.5, 120.5] });
	});
});

describe("how badly the human plays", () => {
	it("survives a shaky tapper at 30ms jitter", () => {
		const beats = metronome1(constantTempo(120), 240);
		const taps = human(beats, plan(burst(0, 8), corrections(12, 240, 12)), {
			seed: 31,
			jitterMs: 30,
		});
		check(runScenario(beats, taps), { median: 27, p95: 80, bpm: [118, 122] });
	});

	it("is tighter still for a drummer at 8ms jitter", () => {
		const beats = metronome1(constantTempo(120), 240);
		const taps = human(beats, plan(burst(0, 8), corrections(12, 240, 12)), {
			seed: 32,
			jitterMs: 8,
		});
		check(runScenario(beats, taps), { median: 6, p95: 18, within20: 0.97, bpm: [119.5, 120.5] });
	});

	it("shrugs off occasional fumbled taps", () => {
		const beats = metronome1(constantTempo(120), 240);
		const taps = human(beats, plan(burst(0, 8), corrections(12, 240, 12)), {
			seed: 33,
			fumbleChance: 0.08,
		});
		check(runScenario(beats, taps), { median: 12, p95: 50, bpm: [118, 122] });
	});

	it("is not derailed by one wild outlier", () => {
		const beats = metronome1(constantTempo(120), 200);
		const taps = human(beats, plan(burst(0, 8), corrections(12, 200, 12)), { seed: 34 });
		taps.splice(10, 0, taps[9] + 180); // a stray tap between two good ones
		const report = runScenario(beats, taps.sort((a, b) => a - b));
		expect(report.finalBpm === null || Math.abs(report.finalBpm - 120) < 3).toBe(true);
		expect(report.medianMs).toBeLessThan(65);
	});

	it("absorbs a systematic early-tapping bias into phase, not tempo", () => {
		const beats = metronome1(constantTempo(120), 240);
		const taps = human(beats, plan(burst(0, 8), corrections(12, 240, 12)), {
			seed: 35,
			leadMs: -25,
		});
		const report = runScenario(beats, taps);
		// The tempo stays right; the grid simply sits early by about the bias.
		check(report, { bpm: [119, 121] });
		expect(report.medianMs).toBeLessThan(40);
	});

	it("ignores hardware bounce - repeated taps inside one beat", () => {
		const beats = metronome1(constantTempo(120), 200);
		const clean = human(beats, plan(burst(0, 8), corrections(12, 200, 12)), { seed: 36 });
		const bounced = clean.flatMap((t) => [t, t + 7, t + 15]).sort((a, b) => a - b);
		check(runScenario(beats, bounced), { median: 16, p95: 55, bpm: [118, 122] });
	});

	it("copes when the human tags along for only part of the piece", () => {
		const beats = metronome1(constantTempo(120), 300);
		const taps = human(beats, plan(burst(0, 10), corrections(12, 90, 12)), { seed: 37 });
		check(runScenario(beats, taps), { median: 30, bpm: [119, 121] });
	});
});

describe("when the music changes", () => {
	it("follows a gradual +1 bpm per 45s ramp", () => {
		const beats = metronome1(ramp(100, 1 / 45), 300);
		const taps = human(beats, plan(burst(0, 6), corrections(12, 300, 12)), { seed: 41 });
		check(runScenario(beats, taps), { median: 22, p95: 56, bpm: [102, 106] });
	});

	it("follows a steeper +1 bpm per 15s ramp", () => {
		const beats = metronome1(ramp(120, 1 / 15), 300);
		const taps = human(beats, plan(burst(0, 6), corrections(8, 300, 8)), { seed: 42 });
		check(runScenario(beats, taps), { median: 24, p95: 60 });
	});

	it("follows a gentle slowdown of -1 bpm per 45s", () => {
		const beats = metronome1(ramp(120, -1 / 45), 300);
		const taps = human(beats, plan(burst(0, 6), corrections(12, 300, 12)), { seed: 91 });
		check(runScenario(beats, taps), { median: 25, p95: 66, bpm: [115.5, 118] });
	});

	it("follows a steeper slowdown of -1 bpm per 15s", () => {
		const beats = metronome1(ramp(140, -1 / 15), 300);
		const taps = human(beats, plan(burst(0, 6), corrections(8, 300, 8)), { seed: 91 });
		check(runScenario(beats, taps), { median: 20, p95: 58, bpm: [130, 133] });
	});

	it("follows a band dragging from 120 down to 104", () => {
		const beats = metronome1(rushThenHold(120, 104, 60), 300);
		const taps = human(beats, plan(burst(0, 6), corrections(8, 300, 8)), { seed: 91 });
		check(runScenario(beats, taps), { median: 21, p95: 76, bpm: [102, 106] });
	});

	it("follows a slow decay from 168 down to 140", () => {
		const beats = metronome1(rushThenHold(168, 140, 90), 400);
		const taps = human(beats, plan(burst(0, 6), corrections(8, 400, 8)), { seed: 91 });
		check(runScenario(beats, taps), { median: 20, p95: 66, bpm: [138, 142] });
	});

	it("tracks drift about as well downwards as upwards", () => {
		// Gradual change in either direction keeps every gap near a whole multiple
		// of the period, so beat numbering stays right and neither direction is
		// especially hard. That is not true of abrupt changes, where a slowdown is
		// markedly the worse case - see the harmonic tests below.
		const plan12 = plan(burst(0, 6), corrections(12, 300, 12));
		const up = runScenario(
			metronome1(ramp(110, 1 / 45), 300),
			human(metronome1(ramp(110, 1 / 45), 300), plan12, { seed: 91 }),
		);
		const down = runScenario(
			metronome1(ramp(110, -1 / 45), 300),
			human(metronome1(ramp(110, -1 / 45), 300), plan12, { seed: 91 }),
		);
		expect(down.medianMs).toBeLessThan(up.medianMs * 2);
		expect(up.medianMs).toBeLessThan(down.medianMs * 2);
	});

	it("adopts a sudden jump to 160 once the human re-taps", () => {
		const beats = metronome1(jump(120, 160, 30), 300);
		const taps = human(
			beats,
			plan(burst(0, 6), corrections(12, 72, 12), burst(74, 8), corrections(88, 300, 12)),
			{ seed: 43 },
		);
		check(runScenario(beats, taps, { fromBeat: 110 }), { median: 20, p95: 36, bpm: [158, 162] });
	});

	it("adopts a sudden drop to 84 once the human re-taps", () => {
		const beats = metronome1(jump(120, 84, 30), 260);
		const taps = human(
			beats,
			plan(burst(0, 6), corrections(12, 56, 12), burst(62, 12), corrections(80, 260, 8)),
			{ seed: 44 },
		);
		// Scored well after the change, once the new tempo has settled. A large
		// slowdown is the weakest case: the tempo comes back accurately, but phase
		// stays looser than on a speed-up, because a slower beat's gaps can be read
		// as more beats of a faster tempo before the evidence rules that out.
		check(runScenario(beats, taps, { fromBeat: 140 }), { median: 42, p95: 190, bpm: [82, 86] });
	});

	it("follows a band rushing from 120 to 132 when tapped through it", () => {
		const beats = metronome1(rushThenHold(120, 132, 60), 300);
		const taps = human(beats, plan(burst(0, 6), corrections(6, 300, 6)), { seed: 45 });
		check(runScenario(beats, taps), { median: 22, p95: 55, bpm: [128, 136] });
	});

	it("follows a band wandering either side of 120", () => {
		const beats = metronome1(wander(120, 0.4, 11), 300);
		const taps = human(beats, plan(burst(0, 6), corrections(8, 300, 8)), { seed: 46 });
		check(runScenario(beats, taps), { median: 18, p95: 50 });
	});

	it.each([
		[160, 85],
		[120, 76],
		[100, 138],
		[144, 92],
	])(
		"recovers from %i to %i without settling on a harmonic",
		(from, to) => {
			// The hard case for any tap tempo: at 85 tapped on every beat, the gaps are
			// also a fair fit for 170 tapped on every other, and 170 is far nearer the
			// tempo already held. What breaks the tie is the convention that a person
			// tapping steadily is tapping the beat itself.
			const tracker = new TempoTracker();
			let t = 0;
			for (let i = 0; i < 10; i++) {
				tracker.addTap(t);
				t += 60000 / from;
			}
			expect(60000 / (tracker.current() as { periodMs: number }).periodMs).toBeCloseTo(from, 0);
			for (let i = 0; i < 16; i++) {
				t += 60000 / to;
				tracker.addTap(t);
			}
			const bpm = 60000 / (tracker.current() as { periodMs: number }).periodMs;
			expect(bpm, `settled on ${bpm.toFixed(2)} rather than ${to}`).toBeCloseTo(to, 0);
		},
	);

	it("cannot tell an exact half-tempo from tapping every other beat", () => {
		// Not a defect but a fact: 60 tapped on every beat and 120 tapped on every
		// second beat produce identical timestamps. No algorithm can separate them,
		// so the tracker holds what it has rather than guessing.
		const tracker = new TempoTracker();
		let t = 0;
		for (let i = 0; i < 10; i++) {
			tracker.addTap(t);
			t += 500;
		}
		for (let i = 0; i < 12; i++) {
			t += 1000;
			tracker.addTap(t);
		}
		const bpm = 60000 / (tracker.current() as { periodMs: number }).periodMs;
		expect([60, 120].some((c) => Math.abs(bpm - c) < 1)).toBe(true);
	});

	it("does not mistake tapping once a bar for a tempo change", () => {
		// Steady gaps of four beats are a whole multiple of the period, give or take
		// the tapper's jitter - the opposite of the harmonic case, and it must not
		// trip the same rule and read 120 as 30.
		const beats = metronome1(constantTempo(120), 200);
		const taps = human(beats, plan(burst(0, 6), every(4, 200, 4)), { seed: 71 });
		check(runScenario(beats, taps), { bpm: [119, 121] });
	});

	it("handles two tempo changes in one piece", () => {
		const beats = metronome1(
			(ms) => (ms < 30000 ? 120 : ms < 60000 ? 140 : 100),
			320,
		);
		// Beat numbers, not seconds: 30s of 120bpm is 60 beats, then 30s of 140bpm
		// is another 70, so the second change lands on beat 130 - not 120.
		const taps = human(
			beats,
			plan(
				burst(0, 6),
				corrections(8, 56, 8),
				burst(60, 10),
				corrections(74, 126, 8),
				burst(130, 10),
				corrections(146, 320, 8),
			),
			{ seed: 47 },
		);
		check(runScenario(beats, taps, { fromBeat: 190 }), { median: 54, p95: 235, bpm: [98, 102] });
	});
});

describe("knowing what it does not know", () => {
	it("will not invent a tempo from lone taps eight bars apart", () => {
		// Nothing distinguishes 32 beats at 120 from 31 at 116, so the honest
		// answer is either the right tempo or none - never a confident wrong one.
		const beats = metronome1(constantTempo(120), 320);
		const taps = human(beats, plan(burst(0, 6), every(32, 320, 32)), { seed: 51 });
		const report = runScenario(beats, taps);
		if (report.finalBpm !== null) {
			expect(Math.abs(report.finalBpm - 120)).toBeLessThan(6);
		}
	});

	it("does not report a tempo before the human has tapped at all", () => {
		const beats = metronome1(constantTempo(120), 60);
		const report = runScenario(beats, [], { warmupBeats: 0 });
		expect(report.scored).toBe(0);
	});

	it("re-locks from scratch after an explicit reset", () => {
		const tracker = new TempoTracker();
		for (const t of [0, 500, 1000, 1500, 2000]) tracker.addTap(t);
		expect(tracker.current()).not.toBeNull();
		tracker.reset();
		expect(tracker.current()).toBeNull();
		for (const t of [10000, 10375, 10750, 11125, 11500]) tracker.addTap(t);
		const grid = tracker.current();
		expect(grid).not.toBeNull();
		expect(60000 / (grid as { periodMs: number }).periodMs).toBeCloseTo(160, 0);
	});

	it("predicts future beats, not just past ones", () => {
		const tracker = new TempoTracker();
		for (const t of [0, 500, 1000, 1500, 2000, 2500]) tracker.addTap(t);
		// Two bars into the future, still on the grid.
		expect(tracker.nearestBeat(6000) as number).toBeCloseTo(6000, 0);
		expect(tracker.errorAt(6000) as number).toBeCloseTo(0, 0);
	});

	it("is deterministic - the same taps give the same grid", () => {
		const beats = metronome1(constantTempo(120), 200);
		const taps = human(beats, plan(burst(0, 8), corrections(12, 200, 12)), { seed: 61 });
		const a = runScenario(beats, taps);
		const b = runScenario(beats, taps);
		expect(a.errors).toEqual(b.errors);
		expect(a.finalBpm).toEqual(b.finalBpm);
	});

	it("holds up across twenty different tappers", () => {
		// Asserted as a distribution rather than a worst case, because the failure
		// mode here is not gradual: now and again a long gap is numbered wrongly
		// and the tracker settles on a slightly wrong tempo that nothing later
		// contradicts. One tapper in twenty currently does this. The test pins how
		// typical the typical case is, and how rare the bad case stays.
		const beats = metronome1(constantTempo(120), 240);
		const medians: number[] = [];
		for (let seed = 100; seed < 120; seed++) {
			const taps = human(beats, plan(burst(0, 6), corrections(16, 240, 16)), { seed });
			const r = runScenario(beats, taps);
			medians.push(r.medianMs);
			// Never wildly wrong, even in the bad case.
			expect(Math.abs((r.finalBpm as number) - 120), `seed ${seed}`).toBeLessThan(3);
		}
		medians.sort((a, b) => a - b);
		const typical = medians[Math.floor(medians.length / 2)];
		const good = medians.filter((m) => m < 25).length;
		expect(typical, `typical tapper median was ${typical.toFixed(1)}ms`).toBeLessThan(18);
		expect(good, `only ${good}/20 tappers stayed under 25ms median`).toBeGreaterThanOrEqual(18);
	});

	it("returns a valid deterministic tempo from wander() during negative pre-roll times (BPM-01)", () => {
		const curveWithPreroll = wander(120, 0.5, 7);
		const prerollValue = curveWithPreroll(-150);
		expect(typeof prerollValue).toBe("number");
		expect(Number.isFinite(prerollValue)).toBe(true);
		expect(() => prerollValue.toFixed(1)).not.toThrow();

		const curveFresh = wander(120, 0.5, 7);
		for (const ms of [0, 500, 1000, 2500, 5000, 10000]) {
			expect(curveWithPreroll(ms)).toBe(curveFresh(ms));
		}
	});

	it("realigns phase on taps after repeated unbridgeable silences past rejectsBeforeUnlock (BPM-03)", () => {
		const tracker = new TempoTracker();
		for (const t of [0, 500, 1000, 1500, 2000, 2500]) {
			tracker.addTap(t);
		}
		for (let i = 1; i <= 7; i++) {
			const tapTime = 2500 + i * 100123;
			tracker.addTap(tapTime);
			expect(tracker.errorAt(tapTime), `long-gap tap ${i}`).toBeCloseTo(0, 5);
			expect(tracker.current()?.periodMs).toBeCloseTo(500, 5);
		}

		// Subsequent valid tapping at a new tempo (150 BPM / 400 ms) reacquires normally.
		const base = 2500 + 7 * 100123;
		for (let j = 1; j <= 4; j++) {
			tracker.addTap(base + j * 400);
		}
		expect(tracker.current()?.periodMs).toBeCloseTo(400, 5);
	});

	it("does not reanchor the published grid on short stray taps across the unlock threshold (BPM-03)", () => {
		const tracker = new TempoTracker();
		for (const t of [0, 500, 1000, 1500, 2000, 2500]) {
			tracker.addTap(t);
		}
		expect(tracker.current()?.anchorMs).toBe(0);

		// A short stray tap (< 2 beats after 2500, landing 0.48 beats off the grid)
		// must be rejected without snapping the published grid's anchorMs to it.
		const stray = 2740;
		tracker.addTap(stray);
		expect(tracker.current()?.anchorMs).toBe(0);
		expect(tracker.errorAt(stray)).toBe(-240);
	});

	it("locks consistently regardless of custom horizons input order without mutating input (BPM-04)", () => {
		const ascending = [2, 4, 8];
		const descending = [8, 4, 2];
		const gridAsc = trackTaps([0, 500, 1000, 1500, 2000], { horizons: ascending });
		const gridDesc = trackTaps([0, 500, 1000, 1500, 2000], { horizons: descending });

		expect(gridDesc).not.toBeNull();
		expect(gridDesc?.periodMs).toBeCloseTo(500, 5);
		expect(gridDesc).toEqual(gridAsc);
		expect(descending).toEqual([8, 4, 2]);
	});
});
