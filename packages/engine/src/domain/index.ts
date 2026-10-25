import type { Memory, Op, Plan, WorldState } from '@wispiva/contract';

export type Diagnostic = { nodeId?: string; requirementId: string; message: string };

export class DomainError extends Error {
  diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join('；'));
    this.name = 'DomainError';
    this.diagnostics = diagnostics;
  }
}

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (value !== null && typeof value === 'object') {
    const cloned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) cloned[key] = cloneJson(item);
    return cloned as T;
  }
  return value;
}

function diagnostic(message: string, requirementId: string, nodeId?: string): Diagnostic {
  return nodeId === undefined ? { requirementId, message } : { nodeId, requirementId, message };
}

function parsePointer(path: unknown): { tokens?: string[]; error?: string } {
  if (typeof path !== 'string') return { error: 'path 必须是字符串。' };
  if (path === '') return { tokens: [] };
  if (!path.startsWith('/')) return { error: 'path 必须是以 / 开头的 JSON Pointer。' };
  const tokens: string[] = [];
  for (const encoded of path.slice(1).split('/')) {
    if (/~(?:[^01]|$)/u.test(encoded)) {
      const invalid = encoded.match(/~(?:[^01]|$)/u)?.[0] ?? '~';
      return { error: `path 含有无效的 JSON Pointer 转义序列 ${invalid}。` };
    }
    const token = encoded.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (forbiddenKeys.has(token)) return { error: `path 指向原型污染敏感键 ${token}。` };
    tokens.push(token);
  }
  return { tokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arrayIndex(token: string, length: number, allowEnd: boolean): number | null {
  if (!/^(0|[1-9]\d*)$/u.test(token)) return null;
  const index = Number(token);
  if (!Number.isSafeInteger(index) || index > length || (!allowEnd && index === length)) return null;
  return index;
}

function getChild(container: unknown, token: string): unknown {
  if (Array.isArray(container)) {
    const index = arrayIndex(token, container.length, false);
    return index === null ? undefined : container[index];
  }
  return isRecord(container) ? container[token] : undefined;
}

function readAt(root: unknown, tokens: string[]): unknown {
  let current = root;
  for (const token of tokens) {
    current = getChild(current, token);
    if (current === undefined) return undefined;
  }
  return current;
}

function writeAt(root: unknown, tokens: string[], op: Op): string | undefined {
  if (tokens.length === 0) return '不允许替换或移除整个世界根节点。';
  let parent = root;
  for (const token of tokens.slice(0, -1)) {
    parent = getChild(parent, token);
    if (parent === undefined) return `path 的父路径不存在：${op.path}。`;
  }
  const leaf = tokens[tokens.length - 1];
  if (leaf === undefined) return `path 的父路径不存在：${op.path}。`;
  if (Array.isArray(parent)) {
    if (op.op === 'set') {
      const index = leaf === '-' ? parent.length : arrayIndex(leaf, parent.length, true);
      if (index === null) return `set 目标数组索引无效：${op.path}。`;
      parent[index] = cloneJson(op.value);
      return undefined;
    }
    const index = arrayIndex(leaf, parent.length, false);
    if (index === null) return `remove 目标 ${op.path} 在当前世界中不存在。`;
    parent.splice(index, 1);
    return undefined;
  }
  if (!isRecord(parent)) return `path 的父路径不存在：${op.path}。`;
  if (op.op === 'remove') {
    if (!Object.hasOwn(parent, leaf)) return `remove 目标 ${op.path} 在当前世界中不存在。`;
    delete parent[leaf];
    return undefined;
  }
  parent[leaf] = cloneJson(op.value);
  return undefined;
}

function applySingle(root: WorldState, op: Op): string | undefined {
  if (!isRecord(op)) return '操作必须是对象。';
  if (op.op !== 'set' && op.op !== 'remove') return 'op 必须是 set 或 remove。';
  if (op.op === 'set' && !Object.hasOwn(op, 'value')) return 'set 操作缺少必需的 value。';
  if (op.op === 'remove' && Object.hasOwn(op, 'value')) return 'remove 操作禁止携带 value。';
  const pointer = parsePointer(op.path);
  if (pointer.error !== undefined || pointer.tokens === undefined) return pointer.error;
  if (op.op === 'remove' && readAt(root, pointer.tokens) === undefined) {
    return `remove 目标 ${op.path} 在当前世界中不存在。`;
  }
  const error = writeAt(root, pointer.tokens, op);
  if (error !== undefined) return error;
  if (pointer.tokens[0] === 'entities' && pointer.tokens[2] === 'location' && op.op === 'set') {
    const target = readAt(root, pointer.tokens);
    const entities = (root as unknown as Record<string, unknown>).entities;
    if (typeof target !== 'string' || !isRecord(entities) || !Object.hasOwn(entities, target)) {
      const value = String(target);
      return `location 值引用了不存在的实体“${value}”。`;
    }
  }
  const worldIssues = validateWorld(root);
  return worldIssues[0]?.message;
}

export function validateOps(world: WorldState, ops: Op[]): Diagnostic[] {
  const candidate = cloneJson(world) as WorldState;
  const diagnostics: Diagnostic[] = [];
  ops.forEach((op, index) => {
    const error = applySingle(candidate, op);
    if (error !== undefined) diagnostics.push(diagnostic(error, 'ops.valid', `ops[${index}]`));
  });
  return diagnostics;
}

export function applyOps(world: WorldState, ops: Op[]): { world: WorldState; changes: string[] } {
  const diagnostics = validateOps(world, ops);
  if (diagnostics.length > 0) throw new DomainError(diagnostics);
  const candidate = cloneJson(world) as WorldState;
  for (const op of ops) applySingle(candidate, op);
  return { world: candidate, changes: ops.map((op) => op.path) };
}

export function validateWorld(world: WorldState): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(world) || !isRecord((world as unknown as Record<string, unknown>).entities)) {
    return [diagnostic('entities 必须是对象。', 'world.entities')];
  }
  const entities = (world as unknown as Record<string, unknown>).entities as Record<string, unknown>;
  for (const [id, entity] of Object.entries(entities)) {
    if (!isRecord(entity)) {
      diagnostics.push(diagnostic(`实体“${id}”必须是对象。`, 'world.entity', id));
      continue;
    }
    if (Object.hasOwn(entity, 'location') && (typeof entity.location !== 'string' || !Object.hasOwn(entities, entity.location))) {
      diagnostics.push(diagnostic(`实体“${id}”的 location 引用了不存在的实体“${String(entity.location)}”。`, 'world.location', id));
    }
  }
  return diagnostics;
}

export function validateMemories(world: WorldState, memories: Memory[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const entities = isRecord(world) && isRecord((world as unknown as Record<string, unknown>).entities)
    ? (world as unknown as Record<string, unknown>).entities as Record<string, unknown>
    : {};
  memories.forEach((memory, index) => {
    const nodeId = `memories[${index}]`;
    if (!isRecord(memory)) {
      diagnostics.push(diagnostic('记忆必须是对象。', 'memory.shape', nodeId));
      return;
    }
    if (typeof memory.owner !== 'string' || !Object.hasOwn(entities, memory.owner)) {
      diagnostics.push(diagnostic(`owner 引用了不存在的实体“${String(memory.owner)}”。`, 'memory.owner', nodeId));
    }
    if (!Array.isArray(memory.about) || memory.about.length === 0) {
      diagnostics.push(diagnostic('about 必须至少包含一个实体引用。', 'memory.about', nodeId));
    } else {
      memory.about.forEach((about, aboutIndex) => {
        if (typeof about !== 'string' || !Object.hasOwn(entities, about)) {
          diagnostics.push(diagnostic(`about 引用了不存在的实体“${String(about)}”。`, 'memory.about', `${nodeId}.about[${aboutIndex}]`));
        }
      });
    }
    if (typeof memory.valence !== 'number' || !Number.isFinite(memory.valence) || memory.valence < -1 || memory.valence > 1) {
      diagnostics.push(diagnostic('valence 必须在 -1 到 1 之间。', 'memory.valence', nodeId));
    }
    if (typeof memory.intensity !== 'number' || !Number.isFinite(memory.intensity) || memory.intensity < 0 || memory.intensity > 1) {
      diagnostics.push(diagnostic('intensity 必须在 0 到 1 之间。', 'memory.intensity', nodeId));
    }
    if (typeof memory.importance !== 'number' || !Number.isInteger(memory.importance) || memory.importance < 1 || memory.importance > 10) {
      diagnostics.push(diagnostic('importance 必须是 1 到 10 的整数。', 'memory.importance', nodeId));
    }
  });
  return diagnostics;
}

export function validatePlan(world: WorldState, plan: Plan): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(plan)) return [diagnostic('plan 必须是对象。', 'plan.shape')];
  if (plan.fromMinutes !== undefined && typeof plan.fromMinutes !== 'number') {
    diagnostics.push(diagnostic('fromMinutes 必须等于基准 worldTimeMinutes。', 'plan.fromMinutes'));
  }
  if (!Array.isArray(plan.events)) return [...diagnostics, diagnostic('events 必须是数组。', 'plan.events')];
  const recordedMinutes = (world as WorldState & { worldTimeMinutes?: number }).worldTimeMinutes;
  const baseMinutes = typeof recordedMinutes === 'number' ? recordedMinutes : Number(plan.fromMinutes);
  const seen = new Set<string>();
  let previousAt = Number.NEGATIVE_INFINITY;
  let candidate = cloneJson(world) as WorldState;
  plan.events.forEach((event, index) => {
    const nodeId = `events[${index}]`;
    if (!isRecord(event)) {
      diagnostics.push(diagnostic('事件必须是对象。', 'plan.event', nodeId));
      return;
    }
    if (event.id === undefined || typeof event.id !== 'string' || seen.has(event.id)) {
      diagnostics.push(diagnostic(`事件 id 缺失或重复：“${String(event.id)}”。`, 'plan.eventId', nodeId));
    } else seen.add(event.id);
    if (typeof event.atMinutes !== 'number' || !Number.isFinite(event.atMinutes) || event.atMinutes < previousAt) {
      diagnostics.push(diagnostic('事件必须按 atMinutes 升序排列。', 'plan.eventOrder', nodeId));
    }
    if (typeof event.atMinutes === 'number' && Number.isFinite(event.atMinutes)) previousAt = event.atMinutes;
    if (typeof event.ops !== 'object' || !Array.isArray(event.ops)) {
      diagnostics.push(diagnostic('事件 ops 必须是数组。', 'plan.ops', nodeId));
    } else {
      const errors = validateOps(candidate, event.ops);
      diagnostics.push(...errors.map((item) => ({ ...item, nodeId: `${nodeId}.${item.nodeId ?? 'ops'}` })));
      if (errors.length === 0) candidate = applyOps(candidate, event.ops).world;
    }
    if (!Array.isArray(event.memories)) {
      diagnostics.push(diagnostic('事件 memories 必须是数组。', 'plan.memories', nodeId));
    } else diagnostics.push(...validateMemories(candidate, event.memories).map((item) => ({ ...item, nodeId: `${nodeId}.${item.nodeId ?? 'memories'}` })));
  });
  if (plan.fromMinutes !== baseMinutes) diagnostics.push(diagnostic('fromMinutes 必须等于基准 worldTimeMinutes。', 'plan.fromMinutes'));
  return diagnostics;
}

export function applyDraft(base: WorldState, ops: Op[]): { world: WorldState; changes: string[] } {
  return applyOps(base, ops);
}
