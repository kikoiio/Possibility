import type { LogEntry, Memory, PlannedEvent, WorldState } from '@wispiva/contract';
import type { BeatInput, LlmGateway } from './index.js';
import type { MemoryRow } from './types.js';

export type MemoryStrategy = 'biased' | 'neutral';

export type AbMemoryArmReport = {
  strategy: MemoryStrategy;
  events: Array<{ beat: number; text: string }>;
  memories: MemoryRow[];
  finalWorld: WorldState;
};

export type AbMemoryReport = {
  schemaVersion: 1;
  runsPerArm: number;
  initialWorld: WorldState;
  arms: [AbMemoryArmReport, AbMemoryArmReport];
};

export type AbMemoryOptions = {
  initialWorld: WorldState;
  gateway: LlmGateway;
  runsPerArm: number;
  applyEvent: (world: WorldState, event: PlannedEvent) => WorldState;
  lineId?: (strategy: MemoryStrategy) => string;
  baseRevisionId?: string;
};

function applyStrategy(memory: Memory, strategy: MemoryStrategy): Memory {
  return strategy === 'biased' ? structuredClone(memory) : { ...structuredClone(memory), valence: 0, intensity: 0 };
}

async function runArm(options: AbMemoryOptions, strategy: MemoryStrategy): Promise<AbMemoryArmReport> {
  let world = structuredClone(options.initialWorld);
  const lineId = options.lineId?.(strategy) ?? `ab-${strategy}`;
  let baseRevisionId = options.baseRevisionId ?? 'ab-origin';
  let worldTimeMinutes = 0;
  const memoryRows: MemoryRow[] = [];
  const events: AbMemoryArmReport['events'] = [];

  for (let beat = 0; beat < options.runsPerArm; beat += 1) {
    const input: BeatInput = {
      lineId,
      baseRevisionId,
      world,
      recentEvents: events.slice(-12).map((entry, index): LogEntry => ({
        id: `${strategy}-rev-${beat}-${index}`,
        parentId: null,
        worldTimeMinutes,
        event: { id: `${strategy}-event-${beat}-${index}`, kind: 'story', text: entry.text, atMinutes: worldTimeMinutes },
      })),
      memoryRows: structuredClone(memoryRows),
      reflections: [],
      worldTimeMinutes,
    };
    const { plan, callId } = await options.gateway.beat(input);
    baseRevisionId = callId;
    for (const event of plan.events) {
      world = options.applyEvent(world, event);
      worldTimeMinutes = Math.max(worldTimeMinutes, event.atMinutes);
      events.push({ beat: beat + 1, text: event.text });
      for (const source of event.memories) {
        const memory = applyStrategy(source, strategy);
        memoryRows.push({ ...memory, lineId, atMinutes: event.atMinutes });
      }
    }
  }
  return { strategy, events, memories: memoryRows, finalWorld: world };
}

export async function runAbMemoryExperiment(options: AbMemoryOptions): Promise<AbMemoryReport> {
  if (!Number.isInteger(options.runsPerArm) || options.runsPerArm < 1) {
    throw new Error('runsPerArm must be a positive integer.');
  }
  const initialWorld = structuredClone(options.initialWorld);
  const arms = await Promise.all([
    runArm(options, 'biased'),
    runArm(options, 'neutral'),
  ]);
  return { schemaVersion: 1, runsPerArm: options.runsPerArm, initialWorld, arms: [arms[0], arms[1]] };
}
