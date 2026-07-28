import { TapTempoEngine } from "../core/tap-tempo";
import type { TapTempoOptions, TempoReading } from "../core/types";

export interface CreateTapTempoOptions extends Partial<TapTempoOptions> {
	/** Clock used when tap() is called without a timestamp. */
	now?: () => number;
	/** Fired only when the reported BPM actually moves. */
	onChange?: (reading: TempoReading) => void;
	/** Fired on every tap, changed or not (e.g. for UI feedback). */
	onReading?: (reading: TempoReading) => void;
}

export interface TapTempo {
	engine: TapTempoEngine;
	tap(timestampMs?: number): TempoReading;
	reading(atMs?: number): TempoReading;
	reset(): void;
}

const defaultNow = (): number =>
	typeof performance !== "undefined" ? performance.now() : Date.now();

/** Plain-callback adapter — works with any event source. */
export function createTapTempo(options: CreateTapTempoOptions = {}): TapTempo {
	const { now = defaultNow, onChange, onReading, ...engineOptions } = options;
	const engine = new TapTempoEngine(engineOptions);
	return {
		engine,
		tap(timestampMs?: number): TempoReading {
			const reading = engine.tap(timestampMs ?? now());
			onReading?.(reading);
			if (reading.changed) onChange?.(reading);
			return reading;
		},
		reading(atMs?: number): TempoReading {
			return engine.reading(atMs ?? now());
		},
		reset(): void {
			engine.reset();
		},
	};
}
