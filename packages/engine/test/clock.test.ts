import { describe, expect, it } from 'vitest';
import { createClockState, dueEvents, sampleClock } from '../src/clock/index.js';
import type { Plan, PlannedEvent } from '@wispiva/contract';

describe('clock', () => {
  it('converts 2.5 real minutes at 24x into 60 world minutes', () => {
    const initial = createClockState('line-a', { anchorWallMs: 1_000 });

    const result = sampleClock(initial, 151_000);

    expect(result.state.anchorWorldMinutes).toBe(60);
    expect(result.newMinutes).toHaveLength(60);
    expect(result.newMinutes[0]).toBe(1);
    expect(result.newMinutes[59]).toBe(60);
  });

  it('does not advance while paused', () => {
    const initial = createClockState('line-a', {
      paused: true,
      anchorWallMs: 1_000,
      anchorWorldMinutes: 12,
    });

    const result = sampleClock(initial, 601_000);

    expect(result.state.anchorWorldMinutes).toBe(12);
    expect(result.state.anchorWallMs).toBe(601_000);
    expect(result.newMinutes).toEqual([]);
  });

  it('accumulates fractional progress across samples until a minute arrives', () => {
    const initial = createClockState('line-a', {
      speed: 1,
      anchorWallMs: 0,
    });

    const first = sampleClock(initial, 30_000);
    const second = sampleClock(first.state, 60_000);

    expect(first.newMinutes).toEqual([]);
    expect(second.newMinutes).toEqual([1]);
    expect(second.state.anchorWorldMinutes).toBe(1);
    expect(second.state.anchorWallMs).toBe(60_000);
  });

  it('returns due events in chronological order, including the boundary', () => {
    const planned: PlannedEvent[] = [
      { id: 'later', atMinutes: 20, text: 'later', ops: [], memories: [] },
      { id: 'boundary', atMinutes: 10, text: 'boundary', ops: [], memories: [] },
      { id: 'earlier', atMinutes: 5, text: 'earlier', ops: [], memories: [] },
    ];
    const plan: Plan = {
      fromMinutes: 0,
      toMinutes: 30,
      events: planned,
      callId: 'call-a',
    };

    expect(dueEvents(plan, 10).map(({ id }) => id)).toEqual(['earlier', 'boundary']);
    expect(dueEvents(null, 10)).toEqual([]);
  });
});
