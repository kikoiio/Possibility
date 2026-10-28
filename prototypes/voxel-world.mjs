import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { prepareVoxelEdit } from './voxel-building.mjs';
import { expandVoxelTools } from './voxel-tools.mjs';

const materials = new Set(['grass', 'dirt', 'stone', 'wood', 'glass', 'water', 'leaves', 'roof']);
const key = position => position.join(',');
const validPosition = p => Array.isArray(p) && p.length === 3 && p.every(n => Number.isSafeInteger(n) && Math.abs(n) <= 1024);
const validMaterial = m => m === null || materials.has(m);
const validString = s => typeof s === 'string' && s.length <= 256 && s.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(s);
const validObject = o => o && validString(o.id) && validString(o.name) && validString(o.kind) &&
  validPosition(o.from) && validPosition(o.to) && o.from.every((n, i) => n <= o.to[i]);
const copyObject = o => o === null ? null : ({ id: o.id, name: o.name, kind: o.kind, from: [...o.from], to: [...o.to] });
const validCellChange = c => c && validPosition(c.position) && validMaterial(c.before) && validMaterial(c.after) && c.before !== c.after;
const validObjectChange = c => c && validString(c.id) && (c.before === null || validObject(c.before) && c.before.id === c.id) &&
  (c.after === null || validObject(c.after) && c.after.id === c.id) && !isDeepStrictEqual(c.before, c.after);
const validBatch = batch => {
  // Earlier files stored each history entry as an array of cell changes.
  const cells = Array.isArray(batch) ? batch : batch?.cells;
  const objects = Array.isArray(batch) ? [] : batch?.objects;
  return Array.isArray(cells) && Array.isArray(objects) && cells.length + objects.length > 0 &&
    cells.every(validCellChange) && new Set(cells.map(c => key(c.position))).size === cells.length &&
    objects.every(validObjectChange) && new Set(objects.map(c => c.id)).size === objects.length;
};

function readStore(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { revision: 0, cells: [], objects: [], undo: [], redo: [] }; throw error; }
  const data = JSON.parse(raw);
  const objects = data?.objects === undefined ? [] : data.objects;
  if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.cells) ||
      !data.cells.every(c => c && validPosition(c.position) && typeof c.material === 'string' && materials.has(c.material)) ||
      new Set(data.cells.map(c => key(c.position))).size !== data.cells.length || !Array.isArray(objects) ||
      !objects.every(validObject) || new Set(objects.map(o => o.id)).size !== objects.length ||
      !Array.isArray(data.undo) || !data.undo.every(validBatch) || !Array.isArray(data.redo) || !data.redo.every(validBatch)) {
    throw new Error('体素世界文件无效');
  }
  return { ...data, objects: objects.map(copyObject) };
}

function writeStore(file, data) {
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError; }
    throw error;
  }
}

/** Synchronous, file-backed world. Mutations return a fresh public state. */
export function createVoxelWorldStore({ file }) {
  if (typeof file !== 'string' || !file) throw new Error('世界文件路径无效');
  let data = readStore(file);
  const publicState = () => ({ revision: data.revision, cells: data.cells.map(c => ({ position: [...c.position], material: c.material })),
    objects: data.objects.map(copyObject), canUndo: data.undo.length > 0, canRedo: data.redo.length > 0 });
  const checkRevision = baseRevision => {
    if (!Number.isSafeInteger(baseRevision) || baseRevision !== data.revision) throw new Error('世界版本冲突');
  };
  const commit = (batch, direction, undo, redo) => {
    if (data.revision === Number.MAX_SAFE_INTEGER) throw new Error('世界版本已达上限');
    const changes = Array.isArray(batch) ? { cells: batch, objects: [] } : batch;
    const cells = new Map(data.cells.map(c => [key(c.position), c]));
    const objects = new Map(data.objects.map(o => [o.id, o]));
    for (const change of changes.cells) {
      const value = change[direction];
      if (value === null) cells.delete(key(change.position));
      else cells.set(key(change.position), { position: [...change.position], material: value });
    }
    for (const change of changes.objects) {
      const value = change[direction];
      if (value === null) objects.delete(change.id);
      else objects.set(change.id, copyObject(value));
    }
    const next = { revision: data.revision + 1, cells: [...cells.values()], objects: [...objects.values()], undo, redo };
    writeStore(file, next);
    data = next;
    return publicState();
  };
  return {
    state: publicState,
    apply({ baseRevision, commands }) {
      checkRevision(baseRevision);
      if (!Array.isArray(commands) || !commands.length || commands.length > 128) throw new Error('建造操作无效');
      commands = expandVoxelTools(commands);
      const cellCommands = [], objects = new Map(data.objects.map(o => [o.id, o]));
      for (const command of commands) {
        if (!command || typeof command !== 'object') throw new Error('不支持的建造操作');
        if (command.op === 'object') {
          if (!validObject(command)) throw new Error('对象定义无效');
          objects.set(command.id, copyObject(command));
        } else if (command.op === 'remove-object') {
          if (!validString(command.id)) throw new Error('对象 ID 无效');
          objects.delete(command.id);
        } else cellCommands.push(command);
      }
      const cells = new Map(data.cells.map(c => [key(c.position), c.material]));
      const cellChanges = cellCommands.length ? prepareVoxelEdit(cellCommands, p => cells.get(key(p)) ?? null, materials) : [];
      const count = data.cells.length + cellChanges.reduce((n, c) => n + (c.after === null ? -1 : 0) + (c.before === null ? 1 : 0), 0);
      if (count > 5000) throw new Error('方块总数不能超过 5000');
      const beforeObjects = new Map(data.objects.map(o => [o.id, o]));
      const ids = new Set([...beforeObjects.keys(), ...objects.keys()]);
      const objectChanges = [...ids].map(id => ({ id, before: beforeObjects.get(id) ?? null, after: objects.get(id) ?? null }))
        .filter(c => !isDeepStrictEqual(c.before, c.after));
      const changes = { cells: cellChanges, objects: objectChanges };
      if (!cellChanges.length && !objectChanges.length) return publicState();
      return commit(changes, 'after', [...data.undo, changes], []);
    },
    undo({ baseRevision }) {
      checkRevision(baseRevision);
      if (!data.undo.length) throw new Error('没有可撤销的操作');
      const changes = data.undo.at(-1);
      return commit(changes, 'before', data.undo.slice(0, -1), [...data.redo, changes]);
    },
    redo({ baseRevision }) {
      checkRevision(baseRevision);
      if (!data.redo.length) throw new Error('没有可重做的操作');
      const changes = data.redo.at(-1);
      return commit(changes, 'after', [...data.undo, changes], data.redo.slice(0, -1));
    },
  };
}
