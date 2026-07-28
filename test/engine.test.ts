import { describe, expect, it } from "vitest";
import { TapTempoEngine } from "../src/core/tap-tempo";
import type { TempoReading } from "../src/core/types";
import { addGhostTap, dropTap, feed, humanTaps } from "./human";

const finalBpm = (readings: TempoReading[]): number | null =>
	readings[readings.length - 1].bpm;

/** Number of report changes after the first lock. */
const changesAfterLock = (readings: TempoReading[]): number => {
	const lockIndex = readings.findIndex((r) => r.changed);
	if (lockIndex === -1) return 0;
	return readings.slice(lockIndex + 1).filter((r) => r.changed).length;
};

describe("golden paths (machine-perfect taps)", () => {
	for (const bpm of [50, 60, 120, 180, 240]) {
		it(`locks to exactly ${bpm} BPM`, () => {
			const engine = new TapTempoEngine();
			const readings = feed(engine, humanTaps({ bpm, taps: 8, jitterPct: 0 }));
			expect(finalBpm(readings)).toBe(bpm);
			expect(readings[readings.length - 1].state).toBe("locked");
			expect(changesAfterLock(readings)).toBe(0);
		});
	}

	it("locks within minTaps intervals (5th tap)", () => {
		const engine = new TapTempoEngine();
		const readings = feed(engine, humanTaps({ bpm: 120, taps: 5, jitterPct: 0 }));
		expect(readings[4].state).toBe("locked");
		expect(readings[4].bpm).toBe(120);
		expect(readings[3].bpm).toBeNull(); // no half-baked output before lock
	});
});

describe("human jitter", () => {
	for (const seed of [1, 2, 3, 4, 5]) {
		it(`3% jitter @120: stays within ±1 and doesn't flap (seed ${seed})`, () => {
			const engine = new TapTempoEngine();
			const readings = feed(
				engine,
				humanTaps({ bpm: 120, taps: 64, jitterPct: 0.03, seed }),
			);
			// warmup exempt: the first report from noisy input is allowed to
			// be a touch off; converged output must be tight.
			for (const r of readings.slice(16)) {
				if (r.bpm !== null) {
					expect(Math.abs(r.bpm - 120)).toBeLessThanOrEqual(1);
				}
			}
			expect(changesAfterLock(readings)).toBeLessThanOrEqual(3);
			// The last 20 readings must all report the same value.
			const tail = readings.slice(-20).map((r) => r.bpm);
			expect(new Set(tail).size).toBe(1);
		});
	}

	for (const seed of [1, 2, 3]) {
		it(`6% jitter @120 (sloppy player): stays within ±2 (seed ${seed})`, () => {
			const engine = new TapTempoEngine();
			const readings = feed(
				engine,
				humanTaps({ bpm: 120, taps: 64, jitterPct: 0.06, seed }),
			);
			for (const r of readings.slice(20)) {
				if (r.bpm !== null) {
					expect(Math.abs(r.bpm - 120)).toBeLessThanOrEqual(2);
				}
			}
			expect(changesAfterLock(readings)).toBeLessThanOrEqual(5);
		});
	}
});

describe("fault tolerance", () => {
	it("ignores switch bounce (ghost tap +30ms)", () => {
		const clean = humanTaps({ bpm: 120, taps: 16, jitterPct: 0 });
		const engine = new TapTempoEngine();
		const readings = feed(engine, addGhostTap(clean, 5, 30));
		expect(finalBpm(readings)).toBe(120);
		expect(changesAfterLock(readings)).toBe(0);
	});

	it("folds a double tap that beats the refractory gate (+250ms)", () => {
		const clean = humanTaps({ bpm: 120, taps: 16, jitterPct: 0 });
		const engine = new TapTempoEngine();
		const readings = feed(engine, addGhostTap(clean, 8, 250));
		expect(finalBpm(readings)).toBe(120);
		expect(changesAfterLock(readings)).toBe(0);
	});

	it("folds a missed beat (one 2x interval)", () => {
		const clean = humanTaps({ bpm: 120, taps: 16, jitterPct: 0 });
		const engine = new TapTempoEngine();
		const readings = feed(engine, dropTap(clean, 8));
		expect(finalBpm(readings)).toBe(120);
		expect(changesAfterLock(readings)).toBe(0);
	});

	it("survives a half-time bar (player taps every 2nd beat)", () => {
		const beat = 500; // 120 BPM
		const timestamps = [
			...Array.from({ length: 8 }, (_, i) => i * beat),
			// two bars tapped half-time on the same grid
			...Array.from({ length: 4 }, (_, i) => 8 * beat + i * 2 * beat),
			// back to every beat
			...Array.from({ length: 8 }, (_, i) => 16 * beat + i * beat),
		];
		const engine = new TapTempoEngine();
		const readings = feed(engine, timestamps);
		expect(finalBpm(readings)).toBe(120);
		expect(changesAfterLock(readings)).toBe(0);
	});

	it("drops backwards timestamps without corrupting state", () => {
		const engine = new TapTempoEngine();
		feed(engine, humanTaps({ bpm: 120, taps: 8, jitterPct: 0 }));
		const before = engine.reading();
		const after = engine.tap(1000); // far in the past
		expect(after.bpm).toBe(before.bpm);
		expect(after.tapCount).toBe(before.tapCount);
		// and the engine keeps working afterwards
		const readings = feed(
			engine,
			humanTaps({ bpm: 120, taps: 8, jitterPct: 0, startAt: 4000 }),
		);
		expect(finalBpm(readings)).toBe(120);
	});
});

describe("tempo changes", () => {
	it("follows the drummer from 120 to 126", () => {
		const first = humanTaps({ bpm: 120, taps: 16, jitterPct: 0 });
		const second = humanTaps({
			bpm: 126,
			taps: 28,
			jitterPct: 0,
			startAt: first[first.length - 1] + 60000 / 126,
		});
		const engine = new TapTempoEngine();
		feed(engine, first);
		const readings = feed(engine, second);
		expect(finalBpm(readings)).toBe(126);
		// converged within 12 taps of the change
		expect(readings[11].bpm).not.toBe(120);
	});

	it("re-latches to a clearly different tempo (120 to 100)", () => {
		const first = humanTaps({ bpm: 120, taps: 16, jitterPct: 0 });
		const second = humanTaps({
			bpm: 100,
			taps: 24,
			jitterPct: 0,
			startAt: first[first.length - 1] + 600,
		});
		const engine = new TapTempoEngine();
		feed(engine, first);
		const readings = feed(engine, second);
		expect(finalBpm(readings)).toBe(100);
	});
});

describe("sessions and pauses", () => {
	it("holds the tempo through a long pause, then re-confirms", () => {
		const first = humanTaps({ bpm: 120, taps: 16, jitterPct: 0 });
		const engine = new TapTempoEngine();
		feed(engine, first);
		// player stops tapping for 5 seconds, then resumes at the same tempo
		const resume = humanTaps({
			bpm: 120,
			taps: 8,
			jitterPct: 0,
			startAt: first[first.length - 1] + 5000,
		});
		const readings = feed(engine, resume);
		for (const r of readings) {
			expect(r.bpm).toBe(120); // never dropped, never changed
			expect(r.state).toBe("locked");
			expect(r.changed).toBe(false);
		}
		expect(readings[0].tapCount).toBe(1); // new session started
	});

	it("adopts a new song's tempo after a pause (120 to 100)", () => {
		const first = humanTaps({ bpm: 120, taps: 16, jitterPct: 0 });
		const engine = new TapTempoEngine();
		feed(engine, first);
		const newSong = humanTaps({
			bpm: 100,
			taps: 12,
			jitterPct: 0,
			startAt: first[first.length - 1] + 4000,
		});
		const readings = feed(engine, newSong);
		expect(finalBpm(readings)).toBe(100);
	});

	it("can slow way down after a pause (120 to 40)", () => {
		// 40 BPM beats (1500ms) exceed the held 120's beat-based timeout;
		// the empty-window timeout floor must let the new tempo in.
		const first = humanTaps({ bpm: 120, taps: 16, jitterPct: 0 });
		const engine = new TapTempoEngine();
		feed(engine, first);
		const newSong = humanTaps({
			bpm: 40,
			taps: 12,
			jitterPct: 0,
			startAt: first[first.length - 1] + 4000,
		});
		const readings = feed(engine, newSong);
		expect(finalBpm(readings)).toBe(40);
	});

	it("reset() returns to idle with no reported tempo", () => {
		const engine = new TapTempoEngine();
		feed(engine, humanTaps({ bpm: 120, taps: 16, jitterPct: 0 }));
		engine.reset();
		const r = engine.reading();
		expect(r.state).toBe("idle");
		expect(r.bpm).toBeNull();
		expect(r.confidence).toBe(0);
	});
});

describe("confidence", () => {
	it("grows with consistent taps", () => {
		const engine = new TapTempoEngine();
		const readings = feed(engine, humanTaps({ bpm: 120, taps: 20, jitterPct: 0 }));
		expect(readings[19].confidence).toBeGreaterThan(readings[4].confidence);
		expect(readings[19].confidence).toBeGreaterThanOrEqual(0.9);
	});

	it("decays with staleness when read with a clock", () => {
		const taps = humanTaps({ bpm: 120, taps: 16, jitterPct: 0 });
		const engine = new TapTempoEngine();
		feed(engine, taps);
		const last = taps[taps.length - 1];
		const freshReading = engine.reading(last + 1000);
		const staleReading = engine.reading(last + 30 * 500);
		expect(staleReading.confidence).toBeLessThan(freshReading.confidence);
		expect(staleReading.bpm).toBe(120); // still held
	});
});

describe("options", () => {
	it("quantizeBpm: 0 reports the unquantized estimate", () => {
		const engine = new TapTempoEngine({ quantizeBpm: 0 });
		const readings = feed(engine, humanTaps({ bpm: 121.3, taps: 16, jitterPct: 0 }));
		expect(finalBpm(readings)).toBeCloseTo(121.3, 1);
	});

	it("maxBpm folds a double-time estimate into range", () => {
		const engine = new TapTempoEngine({ maxBpm: 150 });
		// tapping eighth notes at 120 -> raw 240 -> folded to 120
		const readings = feed(engine, humanTaps({ bpm: 240, taps: 16, jitterPct: 0 }));
		expect(finalBpm(readings)).toBe(120);
	});
});
