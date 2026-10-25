import type { ChatMessage, LogEntry, Minutes, WorldState } from '@wispiva/contract';
import type { MemoryRow, ReflectionRow } from './types.js';

export type BeatInput = {
  lineId: string;
  baseRevisionId: string;
  world: WorldState;
  recentEvents: LogEntry[];
  memoryRows: MemoryRow[];
  reflections: ReflectionRow[];
  worldTimeMinutes: Minutes;
};

type ScoredMemory = { row: MemoryRow; score: number };

function currentSceneEntities(world: WorldState): Set<string> {
  const entities = world.entities;
  const locations = new Set<string>();
  for (const key of ['currentLocation', 'location']) {
    const configuredLocation = world[key];
    if (typeof configuredLocation === 'string') locations.add(configuredLocation);
  }
  for (const [id, entity] of Object.entries(entities)) {
    if (entity.kind === 'place' && entity.current === true) locations.add(id);
  }
  if (locations.size === 0) {
    const characterLocations = new Set(Object.values(entities)
      .filter((entity) => entity.kind === 'character' && typeof entity.location === 'string')
      .map((entity) => entity.location as string));
    if (characterLocations.size === 1) locations.add([...characterLocations][0]!);
  }

  const scene = new Set(locations);
  for (const [id, entity] of Object.entries(entities)) {
    if (entity.kind === 'character' && typeof entity.location === 'string' && locations.has(entity.location)) {
      scene.add(id);
    }
  }
  return scene;
}

function relatedEntities(rows: MemoryRow[], scene: Set<string>, owner: string): Set<string> {
  const related = new Set<string>();
  for (const row of rows) {
    if (row.owner !== owner || !row.about.some((id) => scene.has(id))) continue;
    for (const id of row.about) related.add(id);
  }
  return related;
}

function currentPolarity(rows: MemoryRow[], owner: string, about: string): number {
  let weightedValence = 0;
  let totalWeight = 0;
  for (const row of rows) {
    if (row.owner !== owner || !row.about.includes(about)) continue;
    const weight = row.intensity;
    weightedValence += row.valence * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : weightedValence / totalWeight;
}

export function scoreMemoryRows(input: BeatInput): ScoredMemory[] {
  const scene = currentSceneEntities(input.world);
  return input.memoryRows.map((row) => {
    const tau = 60 * (1 + 9 * row.intensity);
    const elapsed = Math.max(0, input.worldTimeMinutes - row.atMinutes);
    const recency = Math.exp(-elapsed / tau);
    const related = relatedEntities(input.memoryRows, scene, row.owner);
    const relationalHit = row.about.some((id) => related.has(id)) ? 1 : 0;
    const polarity = row.about.length === 0
      ? 0
      : row.about.reduce((sum, id) => sum + currentPolarity(input.memoryRows, row.owner, id), 0) / row.about.length;
    const consistency = polarity === 0 || row.valence === 0
      ? 1
      : Math.sign(polarity) === Math.sign(row.valence)
        ? 1 + Math.abs(polarity)
        : 1 - Math.abs(polarity);
    return { row, score: recency + row.importance + relationalHit * consistency };
  }).sort((left, right) => right.score - left.score
    || left.row.id.localeCompare(right.row.id));
}

function approximateTokens(value: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

function renderMessages(input: BeatInput, memories: MemoryRow[]): ChatMessage[] {
  const system = [
    '你是世界线叙事引擎。严格依据完整世界状态、事件历史与角色记忆推进故事。',
    `世界时间（分钟）: ${input.worldTimeMinutes}`,
    `世界状态:\n${JSON.stringify(input.world, null, 2)}`,
    `近窗事件（按原始顺序逐字保留）:\n${JSON.stringify(input.recentEvents, null, 2)}`,
    `在场角色反思:\n${JSON.stringify(input.reflections, null, 2)}`,
    `检索记忆（按相关性排序；保留 ${memories.length}/${input.memoryRows.length} 条）:\n${JSON.stringify(memories, null, 2)}`,
  ].join('\n\n');
  const user = `请生成接下来 ${input.lineId} 世界线的事件计划，基于 revision ${input.baseRevisionId}。`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export class ContextBudgetError extends Error {
  constructor(readonly budgetTokens: number, readonly requiredTokens: number) {
    super(`Prompt requires approximately ${requiredTokens} tokens; budget is ${budgetTokens}.`);
    this.name = 'ContextBudgetError';
  }
}

export function assembleBeatMessages(input: BeatInput, budgetTokens: number): ChatMessage[] {
  const ranked = scoreMemoryRows(input);
  let best: ChatMessage[] | undefined;
  let minimumRequired = 0;
  let low = 0;
  let high = ranked.length;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const selected = ranked.slice(0, keep).map(({ row }) => row);
    const messages = renderMessages(input, selected);
    const required = messages.reduce((sum, message) => sum + approximateTokens(message.content), 0);
    if (keep === 0) minimumRequired = required;
    if (required <= budgetTokens) {
      best = messages;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  if (best) return best;
  throw new ContextBudgetError(budgetTokens, minimumRequired);
}
