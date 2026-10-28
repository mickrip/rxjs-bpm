import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Pulse, type PulseOptions, pulse } from "./pulse";

/**
 * The pulse operator under fake timers. `Date.now()` is the clock, because fake
 * timers advance it in step with the timers they fire.
 */

interface Seen extends Pulse {
	/** When the pulse arrived, relative to the start of the test. */
	at: number;
	/** `time`, relative to the start of the test. */
	beat: number;
}

let t0 = 0;

function harness(options: PulseOptions<unknown> = {}) {
	const taps = new Subject<unknown>();
	const seen: Seen[] = [];
	const sub = taps.pipe(pulse({ now: () => Date.now(), ...options })).subscribe((p) => {
		seen.push({ ...p, at: Date.now() - t0, beat: p.time - t0 });
	});
	const tapAt = (ms: number) => {
		vi.advanceTimersByTime(ms - (Date.now() - t0));
		taps.next(null);
	};
	const until = (ms: number) => vi.advanceTimersByTime(ms - (Date.now() - t0));
	return { taps, seen, sub, tapAt, until };
}

beforeEach(() => {
	vi.useFakeTimers();
	t0 = Date.now();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("pulse", () => {
	it("is silent until the taps agree on a tempo", () => {
		const h = harness();
		h.tapAt(0);
		h.tapAt(500);
		h.until(1400);
		expect(h.seen).toHaveLength(0);
		h.sub.unsubscribe();
	});

	it("keeps pulsing on the beat after the taps stop", () => {
		const h = harness();
		for (const t of [0, 500, 1000, 1500]) h.tapAt(t);
		h.until(6000);
		const after = h.seen.filter((p) => p.beat > 1500);
		expect(after.length).toBe(9);
		for (const p of after) {
			expect(p.beat % 500).toBeCloseTo(0, 6);
			expect(p.at).toBe(Math.round(p.beat));
			expect(p.bpm).toBeCloseTo(120, 6);
		}
		h.sub.unsubscribe();
	});

	it("numbers pulses without gaps or repeats", () => {
		const h = harness();
		for (const t of [0, 500, 1000, 1500]) h.tapAt(t);
		h.until(4000);
		expect(h.seen.map((p) => p.index)).toEqual(h.seen.map((_, i) => i));
		const beats = h.seen.map((p) => p.beat);
		expect(new Set(beats).size).toBe(beats.length);
		h.sub.unsubscribe();
	});

	it("emits early by leadMs while still reporting the true beat", () => {
		const h = harness({ leadMs: 30 });
		for (const t of [0, 500, 1000, 1500]) h.tapAt(t);
		h.until(4000);
		const after = h.seen.filter((p) => p.beat > 1500);
		expect(after.length).toBeGreaterThan(3);
		for (const p of after) expect(p.at).toBe(Math.round(p.beat - 30));
		h.sub.unsubscribe();
	});

	it("pulls the phase earlier on an early tap without a double pulse", () => {
		const h = harness();
		for (const t of [0, 500, 1000, 1500]) h.tapAt(t);
		h.until(3000);
		// The grid expects 3500. A foot lands 40ms early: that tap is now the beat.
		h.tapAt(3460);
		h.until(5000);
		const near = h.seen.filter((p) => p.beat > 3200 && p.beat < 3800);
		expect(near).toHaveLength(1);
		expect(near[0].beat).toBeCloseTo(3460, 6);
		expect(near[0].at).toBe(3460);
		const next = h.seen.find((p) => p.beat > 3800);
		expect(Math.abs((next?.beat ?? 0) - 3960)).toBeLessThan(10);
		h.sub.unsubscribe();
	});

	it("pushes the phase later on a late tap without a double pulse", () => {
		const h = harness();
		for (const t of [0, 500, 1000, 1500]) h.tapAt(t);
		h.until(3000);
		// The pulse at 3500 has already gone out when the foot lands at 3540.
		h.tapAt(3540);
		h.until(5000);
		const near = h.seen.filter((p) => p.beat > 3200 && p.beat < 3800);
		expect(near).toHaveLength(1);
		const next = h.seen.find((p) => p.beat > 3800);
		expect(Math.abs((next?.beat ?? 0) - 4040)).toBeLessThan(10);
		h.sub.unsubscribe();
	});

	it("follows a new tempo tapped mid-stream", () => {
		const h = harness();
		for (const t of [0, 500, 1000, 1500]) h.tapAt(t);
		h.until(4000);
		for (const t of [4000, 4400, 4800, 5200, 5600, 6000]) h.tapAt(t);
		h.until(9000);
		const last = h.seen.at(-1);
		expect(last?.bpm).toBeCloseTo(150, 0);
		expect((last?.beat ?? 0) - 6000).toBeCloseTo(Math.round(((last?.beat ?? 0) - 6000) / 400) * 400, 0);
		h.sub.unsubscribe();
	});

	it("uses the event's own timestamp when given one", () => {
		const taps = new Subject<number>();
		const seen: Pulse[] = [];
		const sub = taps
			.pipe(pulse({ now: () => Date.now(), timestamp: (t) => t0 + t }))
			.subscribe((p) => seen.push(p));
		// Events arrive late and bunched, but carry their true times.
		vi.advanceTimersByTime(1520);
		for (const t of [0, 500, 1000, 1500]) taps.next(t);
		vi.advanceTimersByTime(1500);
		expect(seen.length).toBeGreaterThan(0);
		for (const p of seen) expect((p.time - t0) % 500).toBeCloseTo(0, 6);
		sub.unsubscribe();
	});

	it("carries on when the taps complete, and stops on unsubscribe", () => {
		const h = harness();
		for (const t of [0, 500, 1000, 1500]) h.tapAt(t);
		h.taps.complete();
		h.until(3000);
		const count = h.seen.length;
		expect(count).toBeGreaterThan(0);
		h.sub.unsubscribe();
		expect(vi.getTimerCount()).toBe(0);
		h.until(6000);
		expect(h.seen.length).toBe(count);
	});

	it("passes an error in the taps through", () => {
		const taps = new Subject<unknown>();
		const error = vi.fn();
		taps.pipe(pulse({ now: () => Date.now() })).subscribe({ error });
		taps.error(new Error("pedal unplugged"));
		expect(error).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});
