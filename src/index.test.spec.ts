
import { Subject, take, toArray } from 'rxjs';
import { createBPMObservable } from './index';
import { describe, it, expect } from 'vitest';

describe('createBPMObservable', async () => {

    it('should calculate BPM correctly', async () => {
        const source$ = new Subject<number>();
        const bpm$ = createBPMObservable(source$);

        // Create an array to store BPM values
        const bpmValues: number[] = [];

        // Subscribe to bpm$ and collect values
        const subscription = bpm$.pipe(
            take(3),
            toArray()
        ).subscribe(values => {
            bpmValues.push(...values);
        });

        for (let i = 0; i < 4; i++) {
            await new Promise(resolve => setTimeout(() => {
                source$.next(1);
                resolve(null);
            }, 500));
        }

        await new Promise(resolve => subscription.add(() => resolve(null)));

        expect(bpmValues[1]).toBeCloseTo(120, 2);
        expect(bpmValues[2]).toBeCloseTo(120, 2);
    });



});
