import {
	type Observable,
	throttleTime,
	map,
	distinctUntilChanged,
	tap,
	share,
	filter,
	ReplaySubject,
	scan,
} from "rxjs";

// Function to create a BPM observable
export function createBPMObservable(event$: Observable<unknown>): Observable<number> {
	const bpmSubject = new ReplaySubject<number>(0);

	event$
		.pipe(
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
						.map((timestamp, i) => 60000 / (timestamp - timestamps[i]));
				};

				const filterOutliers = (
					values: number[],
					threshold: number,
				): number[] => {
					const mostTrusted = values[0]; // Use the first interval as the baseline (most trusted)
					return values.reduce<number[]>((acc, curr) => {
						// Calculate the deviation of each interval from the most trusted interval
						const deviation = Math.abs(curr / mostTrusted - 1);
						// If deviation is above the threshold (0.1), consider it an outlier and don't include it
						if (deviation <= threshold) {
							acc.push(curr); // Directly push valid items to the accumulator
						}
						return acc; // Return the accumulator
					}, []);
				};

				// Calculate the intervals (differences) between consecutive timestamps
				const intervals = calculateIntervals(timestamps);
				intervals.reverse();

				const finalIntervals = filterOutliers(intervals, 0.1);

				if (finalIntervals.length === 0) {
					return 0; // Return 0 if no valid intervals are left after filtering
				}

				// Calculate the average BPM from the remaining intervals
				const averageBPM =
					finalIntervals.reduce((acc, curr) => acc + curr, 0) /
					finalIntervals.length;
				return averageBPM;
			}),
			distinctUntilChanged(),
			filter((bpm) => bpm > 60),
			tap((bpm) => {
				bpmSubject.next(Math.round(bpm));
			}),
			share(),
		)
		.subscribe();

	return bpmSubject.asObservable();
}


