import type { EpochMs, Minutes, Plan, PlannedEvent } from '@wispiva/contract';

export type LineClockState = {
  lineId: string;
  speed: number;
  paused: boolean;
  anchorWallMs: EpochMs;
  anchorWorldMinutes: number;
};

const millisecondsPerMinute = 60_000;

export function createClockState(
  lineId: string,
  opts: Partial<LineClockState> = {},
): LineClockState {
  return {
    ...opts,
    lineId,
    speed: opts.speed ?? 24,
    paused: opts.paused ?? false,
    anchorWallMs: opts.anchorWallMs ?? Date.now(),
    anchorWorldMinutes: opts.anchorWorldMinutes ?? 0,
  };
}

export function sampleClock(
  state: LineClockState,
  now: EpochMs,
): { state: LineClockState; newMinutes: number[] } {
  if (state.paused || state.speed <= 0 || now <= state.anchorWallMs) {
    return {
      state: state.paused ? { ...state, anchorWallMs: now } : { ...state },
      newMinutes: [],
    };
  }

  const elapsedWorldMinutes =
    ((now - state.anchorWallMs) * state.speed) / millisecondsPerMinute;
  const roundingTolerance = Number.EPSILON * Math.max(1, elapsedWorldMinutes) * 8;
  const wholeMinutes = Math.floor(elapsedWorldMinutes + roundingTolerance);
  if (wholeMinutes <= 0) {
    return { state: { ...state }, newMinutes: [] };
  }

  const nextWorldMinute = state.anchorWorldMinutes + wholeMinutes;
  const nextWallAnchor =
    state.anchorWallMs + (wholeMinutes * millisecondsPerMinute) / state.speed;

  return {
    state: {
      ...state,
      anchorWallMs: nextWallAnchor,
      anchorWorldMinutes: nextWorldMinute,
    },
    newMinutes: Array.from({ length: wholeMinutes }, (_, index) => state.anchorWorldMinutes + index + 1),
  };
}

export function dueEvents(
  plan: Plan | null,
  worldTimeMinutes: Minutes,
): PlannedEvent[] {
  if (plan === null) {
    return [];
  }

  return plan.events
    .filter((event) => event.atMinutes <= worldTimeMinutes)
    .slice()
    .sort((left, right) => left.atMinutes - right.atMinutes);
}
