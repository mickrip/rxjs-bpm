import {
	Observable,
	type Subscription,
	throttleTime,
	map,
	distinctUntilChanged,
	filter,
	ReplaySubject,
	scan,
} from "rxjs";

// Function to create a BPM observable
export function createBPMObservable(event$: Observable<unknown>): Observable<number> {
	const bpmSubject = new ReplaySubject<number>(1);
	let sourceSub: Subscription | null = null;
	let refCount = 0;
	let terminated = false;

	const pipeline$ = event$.pipe(
		throttleTime(200), // Ignore events that occur within 200ms of each other
		map(() => performance.now()),
		scan((acc, timestamp) => {
			return [...acc, timestamp].slice(-8);
		}, [] as number[]),
		map((timestamps: number[]) => {
			if (timestamps.length < 2) {
				return 0; // Not enough data to calculate BPM
			}

			const calculateIntervals = (timestamps: number[]): number[] => {
				// Calculate intervals between consecutive timestamps in milliseconds
				return timestamps
					.slice(1)
					.map((timestamp, i) => timestamp - timestamps[i]);
			};

			const selectBaseline = (
				values: number[],
				threshold: number,
			): number => {
				if (values.length === 1) {
					return values[0];
				}
				// If the two most recent intervals agree, trust the newest interval
				// so deliberate tempo changes are picked up promptly.
				if (Math.abs(values[0] / values[1] - 1) <= threshold) {
					return values[0];
				}
				// Otherwise, a single uncorroborated jump is likely a mistimed tap;
				// use the median interval (or the prior interval when only 2 exist).
				if (values.length === 2) {
					return values[1];
				}
				const sorted = [...values].sort((a, b) => a - b);
				return sorted[Math.floor((sorted.length - 1) / 2)];
			};

			const filterOutliers = (
				values: number[],
				threshold: number,
			): number[] => {
				const mostTrusted = selectBaseline(values, threshold);
				return values.reduce<number[]>((acc, curr) => {
					// Calculate the deviation of each interval from the baseline interval
					const deviation = Math.abs(curr / mostTrusted - 1);
					// If deviation is above the threshold (0.1), consider it an outlier and don't include it
					if (deviation <= threshold) {
						acc.push(curr);
					}
					return acc;
				}, []);
			};

			// Calculate the intervals (differences) between consecutive timestamps
			const intervals = calculateIntervals(timestamps);
			intervals.reverse();

			const finalIntervals = filterOutliers(intervals, 0.1);

			if (finalIntervals.length === 0) {
				return 0; // Return 0 if no valid intervals are left after filtering
			}

			// Calculate the average interval in ms and convert to BPM
			const averageInterval =
				finalIntervals.reduce((acc, curr) => acc + curr, 0) /
				finalIntervals.length;
			return 60000 / averageInterval;
		}),
		// Round before filtering and de-duplicating, so boundary checks and
		// distinctUntilChanged evaluate the integer BPM that is actually emitted.
		map((bpm) => Math.round(bpm)),
		filter((bpm) => bpm > 60),
		distinctUntilChanged(),
	);

	const connect = () => {
		if (sourceSub || terminated) return;
		const sub = pipeline$.subscribe({
			next: (bpm) => bpmSubject.next(bpm),
			error: (err) => {
				terminated = true;
				sourceSub = null;
				bpmSubject.error(err);
			},
			complete: () => {
				terminated = true;
				sourceSub = null;
				bpmSubject.complete();
			},
		});
		if (!terminated) {
			sourceSub = sub;
		}
	};

	// Connect eagerly so events arriving before the first subscriber are captured
	// and replayed, while tearing down the upstream subscription once all active
	// subscribers unsubscribe.
	connect();

	return new Observable<number>((subscriber) => {
		refCount += 1;
		connect();
		const sub = bpmSubject.subscribe(subscriber);
		return () => {
			sub.unsubscribe();
			refCount -= 1;
			if (refCount === 0 && sourceSub) {
				sourceSub.unsubscribe();
				sourceSub = null;
			}
		};
	});
}

export { pulse, type Pulse, type PulseOptions } from "./pulse";
export {
	TempoTracker,
	trackTaps,
	type TempoGrid,
	type TempoTrackerOptions,
} from "./tempo-tracker";
