import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBPMObservable } from "./index";

function createTapHarness() {
	const events$ = new Subject<void>();
	const values: number[] = [];
	createBPMObservable(events$).subscribe((bpm) => values.push(bpm));
	const tap = (gap = 0) => {
		vi.advanceTimersByTime(gap);
		events$.next();
	};
	return {
		values,
		tap,
		tapGaps: (gaps: number[]) => gaps.forEach((gap) => tap(gap)),
	};
}

describe("createBPMObservable", () => {
	beforeEach(() => {
		// The implementation timestamps events with performance.now(), so fake the
		// clock as well as timers to make human-timing scenarios deterministic.
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
		});
	});

	afterEach(() => vi.useRealTimers());

	describe("basic tempo inference", () => {
		it("does not infer intent from one isolated click", () => {
			const { values, tap } = createTapHarness();
			tap();
			expect(values).toEqual([]);
		});

		it.each([
			{ gap: 1_000, bpm: 60 },
			{ gap: 750, bpm: 80 },
			{ gap: 500, bpm: 120 },
			{ gap: 400, bpm: 150 },
			{ gap: 250, bpm: 240 },
		])("infers $bpm BPM from repeated $gap ms taps", ({ gap, bpm }) => {
			const { values, tapGaps } = createTapHarness();
			tapGaps([0, gap, gap, gap]);
			// The current public contract excludes 60 BPM itself.
			expect(values.at(-1)).toBe(bpm === 60 ? undefined : bpm);
		});

		it("reports a stable tempo only once", () => {
			const { values, tapGaps } = createTapHarness();
			tapGaps([0, 500, 500, 500, 500, 500]);
			expect(values).toEqual([120]);
		});

		it("emits a new value after a deliberate tempo change", () => {
			const { values, tapGaps } = createTapHarness();
			tapGaps([0, 500, 500, 500, 400, 400, 400]);
			expect(values).toEqual([120, 150]);
		});
	});

	describe("human timing", () => {
		it("settles near the intended tempo with ordinary hand jitter", () => {
			const { values, tapGaps } = createTapHarness();
			// Mean gap is 500 ms (120 BPM), with realistic early and late taps.
			tapGaps([0, 492, 508, 485, 515, 497, 503, 490, 510]);
			expect(values.at(-1)).toBeCloseTo(120, 0);
			expect(values.every((bpm) => bpm >= 118 && bpm <= 122)).toBe(true);
		});

		it("recovers after extreme but non-double-click jitter", () => {
			const { values, tapGaps } = createTapHarness();
			// The first section is erratic; the final four taps clearly express 120.
			tapGaps([0, 310, 690, 380, 620, 500, 500, 500, 500]);
			expect(values.at(-1)).toBe(120);
		});

		it("ignores an accidental double-click inside the 200 ms guard window", () => {
			const { values, tapGaps } = createTapHarness();
			// Intended taps are at 0, 500, 1000 and 1500 ms; 550 ms is accidental.
			tapGaps([0, 500, 50, 450, 500]);
			expect(values).toEqual([120]);
		});

		it("accepts a tap exactly at the 200 ms throttle boundary", () => {
			const { values, tapGaps } = createTapHarness();
			tapGaps([0, 200, 200]);
			expect(values).toEqual([300]);
		});

		it("does not let hardware-bounce clicks distort later timing", () => {
			const { values, tapGaps } = createTapHarness();
			tapGaps([0, 20, 30, 450, 15, 25, 460, 10, 30, 460]);
			expect(values).toEqual([120]);
		});
	});

	describe("session and history behaviour", () => {
		it("does not emit for two isolated clicks separated by a long pause", () => {
			const { values, tapGaps } = createTapHarness();
			tapGaps([0, 5_000]);
			expect(values).toEqual([]);
		});

		it("can establish a fresh tempo after a long pause", () => {
			const { values, tapGaps } = createTapHarness();
			tapGaps([0, 500, 500, 5_000, 400, 400]);
			expect(values.at(-1)).toBe(150);
		});

		it("eventually forgets timing outside its eight-tap window", () => {
			const { values, tapGaps } = createTapHarness();
			tapGaps([0, 600, 600, 600, 500, 500, 500, 500, 500, 500, 500, 500]);
			expect(values.at(-1)).toBe(120);
		});

		it("replays the latest inferred tempo to a late subscriber", () => {
			const events$ = new Subject<void>();
			const bpm$ = createBPMObservable(events$);
			events$.next();
			vi.advanceTimersByTime(500);
			events$.next();
			const lateValues: number[] = [];
			bpm$.subscribe((bpm) => lateValues.push(bpm));
			expect(lateValues).toEqual([120]);
		});
	});

	describe("unresolved intent heuristics", () => {
		it.fails("does not treat one late accidental tap as a new believable tempo", () => {
			const { values, tapGaps } = createTapHarness();
			// 120 BPM is established; one hesitation is weak evidence for 75 BPM.
			tapGaps([0, 500, 500, 500, 800, 500, 500]);
			expect(values).not.toContain(75);
			expect(values.at(-1)).toBe(120);
		});

		it.fails("requires more than one interval before declaring initial intent", () => {
			const { values, tapGaps } = createTapHarness();
			// Two unrelated clicks may coincidentally be 500 ms apart.
			tapGaps([0, 500]);
			expect(values).toEqual([]);
		});

		it.fails("does not anchor the estimate to a wildly mistimed newest tap", () => {
			const { values, tapGaps } = createTapHarness();
			// Six taps establish 120 BPM; one early tap should not outweigh them.
			tapGaps([0, 500, 500, 500, 500, 500, 260]);
			expect(values.at(-1)).toBeCloseTo(120, 0);
		});
	});
});
