import {
	asyncScheduler,
	Observable,
	type OperatorFunction,
	type SchedulerLike,
	type Subscription,
} from "rxjs";
import { TempoTracker, type TempoTrackerOptions } from "./tempo-tracker";

/**
 * Turn a stream of taps into a stream of beats.
 *
 * Each input event is a tap - a key, a foot pedal, a MIDI note. Once enough
 * taps agree on a tempo, a pulse is emitted on every beat, and it keeps coming
 * when the taps stop. A later tap steers it: tap on the beat to pull the phase
 * into line, or tap a new tempo to move it there.
 *
 * ```ts
 * fromEvent<KeyboardEvent>(window, "keydown")
 *   .pipe(
 *     filter((e) => e.code === "Space" && !e.repeat),
 *     pulse({ timestamp: (e) => e.timeStamp, leadMs: 20 }),
 *   )
 *   .subscribe((p) => lights.flash(p.bpm));
 * ```
 *
 * Pulses are emitted from timers, which fire a little late - a millisecond or
 * so in Node, more in a browser and much more in a background tab. `time` is
 * always the exact beat, so a consumer that can schedule ahead should use it
 * rather than the moment the pulse arrived.
 *
 * Every subscription runs its own tracker. Share the result to drive several
 * consumers from one tempo.
 */

export interface Pulse {
	/** The moment this beat falls, on the clock given by `now`. */
	time: number;
	/** Running count of pulses on this subscription, from 0. */
	index: number;
	/** Current tempo. */
	bpm: number;
	/** Milliseconds between beats at the current tempo. */
	periodMs: number;
}

export interface PulseOptions<T> extends TempoTrackerOptions {
	/**
	 * Emit each pulse this many milliseconds before its beat, to absorb latency
	 * downstream of the pulse - a lighting desk, a DMX interface, a lamp that is
	 * slow to come up. Negative values delay the pulse.
	 *
	 * Keep it as small as the latency allows. A pulse already emitted cannot be
	 * recalled, so a tap that lands within `leadMs` before a beat corrects the
	 * phase from the following beat instead of that one.
	 */
	leadMs?: number;
	/**
	 * How late a pulse may still be emitted. When a tap pulls the beat earlier
	 * than a pulse already planned, the beat it lands on has often just passed.
	 * Within this window it is emitted at once; beyond it, it is skipped.
	 */
	lateToleranceMs?: number;
	/**
	 * When a tap happened. Defaults to `now()` as the event arrives. Pass the
	 * event's own timestamp where it has one - `KeyboardEvent.timeStamp`,
	 * `MIDIMessageEvent.timeStamp` - which is taken earlier and is unaffected by
	 * a busy thread. It must be on the same clock as `now`.
	 */
	timestamp?: (event: T) => number;
	/** The clock taps and pulses are measured on. Defaults to `performance.now()`. */
	now?: () => number;
	/** Scheduler the pulse timers run on. Defaults to `asyncScheduler`. */
	scheduler?: SchedulerLike;
}

const performanceNow = () => performance.now();

export function pulse<T = unknown>(options: PulseOptions<T> = {}): OperatorFunction<T, Pulse> {
	const {
		leadMs = 0,
		lateToleranceMs = 50,
		timestamp,
		now = performanceNow,
		scheduler = asyncScheduler,
		...trackerOptions
	} = options;

	return (source) =>
		new Observable<Pulse>((subscriber) => {
			const tracker = new TempoTracker(trackerOptions);
			let lastBeat = Number.NEGATIVE_INFINITY;
			let index = 0;
			let timer: Subscription | null = null;

			/**
			 * Plan the next pulse from the grid as it stands. Called after every tap,
			 * because a tap can move the grid, and after every pulse.
			 */
			const plan = () => {
				timer?.unsubscribe();
				timer = null;
				const grid = tracker.current();
				if (!grid) return;
				const { anchorMs, periodMs } = grid;
				const t = now();
				// Two limits on the next beat. It must be clearly a different beat from
				// the last one pulsed - a late tap shifts the grid by a few ms, and the
				// beat it lands on has already been pulsed. And it must not be so far in
				// the past that emitting it now would be a visible mistake.
				const earliest = Math.max(lastBeat + periodMs / 2, t + leadMs - lateToleranceMs);
				const beat = anchorMs + Math.ceil((earliest - anchorMs) / periodMs) * periodMs;
				timer = scheduler.schedule(() => {
					timer = null;
					lastBeat = beat;
					subscriber.next({ time: beat, index: index++, bpm: 60000 / periodMs, periodMs });
					plan();
				}, Math.max(0, beat - leadMs - t));
			};

			const tapSub = source.subscribe({
				next: (event) => {
					tracker.addTap(timestamp ? timestamp(event) : now());
					plan();
				},
				error: (err) => subscriber.error(err),
				// A metronome keeps going when the taps stop, so the end of the taps is
				// not the end of the pulses. Unsubscribe to stop it.
				complete: () => {},
			});

			return () => {
				tapSub.unsubscribe();
				timer?.unsubscribe();
			};
		});
}
