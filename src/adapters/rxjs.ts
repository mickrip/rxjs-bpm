import {
	defer,
	filter,
	map,
	type Observable,
	share,
	startWith,
} from "rxjs";
import { TapTempoEngine } from "../core/tap-tempo";
import type { TapTempoOptions, TempoReading } from "../core/types";

export interface RxTapTempoOptions extends Partial<TapTempoOptions> {
	/** Clock used to timestamp incoming events. */
	now?: () => number;
}

const defaultNow = (): number =>
	typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * Full readings stream. One engine is shared across subscribers; each new
 * subscriber immediately receives the current reading, then live updates.
 */
export function createTempoObservable(
	event$: Observable<unknown>,
	options: RxTapTempoOptions = {},
): Observable<TempoReading> {
	const { now = defaultNow, ...engineOptions } = options;
	const engine = new TapTempoEngine(engineOptions);
	const readings$ = event$.pipe(
		map(() => engine.tap(now())),
		share(),
	);
	return defer(() => readings$.pipe(startWith(engine.reading(now()))));
}

/**
 * @deprecated Compatibility surface for the 0.0.x API. Emits the reported
 * BPM only when it changes. Prefer `createTempoObservable`, which exposes
 * confidence and state and lets you decide what to do with each reading.
 */
export function createBPMObservable(
	event$: Observable<unknown>,
	options: RxTapTempoOptions = {},
): Observable<number> {
	return createTempoObservable(event$, options).pipe(
		filter((r): r is TempoReading & { bpm: number } => r.changed && r.bpm !== null),
		map((r) => r.bpm),
	);
}
