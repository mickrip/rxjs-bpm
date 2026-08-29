import { Subject } from 'rxjs';
import { createBPMObservable } from './index';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('createBPMObservable', () => {

    beforeEach(() => {
        // `performance` must be faked alongside the timers: the pipeline stamps each
        // event with performance.now(), so without it the BPM would still be derived
        // from the real wall clock and drift off 120.
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should calculate BPM correctly', () => {
        const source$ = new Subject<number>();
        const bpm$ = createBPMObservable(source$);

        // Create an array to store BPM values
        const bpmValues: number[] = [];
        bpm$.subscribe(bpm => bpmValues.push(bpm));

        // Four beats exactly 500ms apart => 60000 / 500 => 120 BPM.
        for (let i = 0; i < 4; i++) {
            vi.advanceTimersByTime(500);
            source$.next(1);
        }

        // A single emission, not one per beat: the reported BPM only changes once.
        expect(bpmValues).toEqual([120]);
    });

    it('should not re-emit a BPM that has not changed', () => {
        const source$ = new Subject<number>();
        const bpm$ = createBPMObservable(source$);

        const bpmValues: number[] = [];
        bpm$.subscribe(bpm => bpmValues.push(bpm));

        // Beats that wobble by a millisecond either way, as real input always does.
        // The underlying averages all differ slightly, but they round to the same BPM,
        // so only the first one should reach the subscriber.
        for (const gap of [500, 501, 499, 500]) {
            vi.advanceTimersByTime(gap);
            source$.next(1);
        }

        expect(bpmValues).toEqual([120]);
    });

    it('should emit again when the BPM actually changes', () => {
        const source$ = new Subject<number>();
        const bpm$ = createBPMObservable(source$);

        const bpmValues: number[] = [];
        bpm$.subscribe(bpm => bpmValues.push(bpm));

        // Settle at 120 BPM, then jump to 400ms beats => 150 BPM.
        for (const gap of [500, 500, 500, 500, 400, 400, 400, 400]) {
            vi.advanceTimersByTime(gap);
            source$.next(1);
        }

        expect(bpmValues).toEqual([120, 150]);
    });

});
