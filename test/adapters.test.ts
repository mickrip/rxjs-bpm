import { Subject } from "rxjs";
import { describe, expect, it } from "vitest";
import { createTapTempo } from "../src/adapters/callback";
import {
	createBPMObservable,
	createTempoObservable,
} from "../src/adapters/rxjs";
import type { TempoReading } from "../src/core/types";
import { humanTaps } from "./human";

describe("callback adapter", () => {
	it("fires onChange only when the reported BPM moves", () => {
		const changes: TempoReading[] = [];
		const everyReading: TempoReading[] = [];
		const tempo = createTapTempo({
			onChange: (r) => changes.push(r),
			onReading: (r) => everyReading.push(r),
		});
		const taps = humanTaps({ bpm: 120, taps: 16, jitterPct: 0 });
		for (const t of taps) tempo.tap(t);

		expect(everyReading).toHaveLength(16);
		expect(changes).toHaveLength(1); // the initial lock, then silence
		expect(changes[0].bpm).toBe(120);
		expect(tempo.reading(taps[taps.length - 1]).bpm).toBe(120);
	});

	it("uses the injected clock when tap() is called bare", () => {
		let t = 0;
		const tempo = createTapTempo({ now: () => t });
		for (const stamp of humanTaps({ bpm: 100, taps: 8, jitterPct: 0 })) {
			t = stamp;
			tempo.tap();
		}
		expect(tempo.reading(t).bpm).toBe(100);
	});
});

describe("rxjs adapter", () => {
	it("emits readings on every event and supports teardown", () => {
		let t = 0;
		const source$ = new Subject<void>();
		const tempo$ = createTempoObservable(source$, { now: () => t });

		const readings: TempoReading[] = [];
		const sub = tempo$.subscribe((r) => readings.push(r));
		expect(readings).toHaveLength(1); // current (idle) reading on subscribe
		expect(readings[0].state).toBe("idle");

		for (const stamp of humanTaps({ bpm: 120, taps: 8, jitterPct: 0 })) {
			t = stamp;
			source$.next();
		}
		expect(readings).toHaveLength(9);
		expect(readings[readings.length - 1].bpm).toBe(120);

		sub.unsubscribe();
		expect(source$.observed).toBe(false); // no leaked subscription
	});

	it("gives a late subscriber the current reading immediately", () => {
		let t = 0;
		const source$ = new Subject<void>();
		const tempo$ = createTempoObservable(source$, { now: () => t });
		const first = tempo$.subscribe();

		for (const stamp of humanTaps({ bpm: 120, taps: 8, jitterPct: 0 })) {
			t = stamp;
			source$.next();
		}

		const late: TempoReading[] = [];
		const second = tempo$.subscribe((r) => late.push(r));
		expect(late).toHaveLength(1);
		expect(late[0].bpm).toBe(120);

		first.unsubscribe();
		second.unsubscribe();
	});

	it("createBPMObservable (deprecated) emits numbers only on change", () => {
		let t = 0;
		const source$ = new Subject<void>();
		const bpm$ = createBPMObservable(source$, { now: () => t });
		const values: number[] = [];
		const sub = bpm$.subscribe((v) => values.push(v));

		for (const stamp of humanTaps({ bpm: 120, taps: 32, jitterPct: 0 })) {
			t = stamp;
			source$.next();
		}
		expect(values).toEqual([120]);
		sub.unsubscribe();
	});
});
