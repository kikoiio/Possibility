import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { prepareVoxelEdit } from './voxel-building.mjs';
import { expandVoxelTools } from './voxel-tools.mjs';

export const VOXEL_MATERIALS = Object.freeze(['grass', 'dirt', 'stone', 'wood', 'glass', 'water', 'leaves', 'roof']);
const materials = new Set(VOXEL_MATERIALS);
const key = position => position.join(',');
const validPosition = p => Array.isArray(p) && p.length === 3 && p.every(n => Number.isSafeInteger(n) && Math.abs(n) <= 1024);
const validMaterial = m => m === null || materials.has(m);
const validString = s => typeof s === 'string' && s.length <= 256 && s.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(s);
const validObject = o => o && validString(o.id) && validString(o.name) && validString(o.kind) &&
  validPosition(o.from) && validPosition(o.to) && o.from.every((n, i) => n <= o.to[i]) &&
  (o.members === undefined || Array.isArray(o.members) && o.members.length <= 5000 &&
    o.members.every(p => validPosition(p) && inside(p, o)) && new Set(o.members.map(key)).size === o.members.length);
const inside = (p, o) => p.every((v, i) => v >= o.from[i] && v <= o.to[i]);
const copyObject = o => o === null ? null : ({ id: o.id, name: o.name, kind: o.kind, from: [...o.from], to: [...o.to],
  ...(o.members === undefined ? {} : { members: o.members.map(p => [...p]) }) });
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
  return validateStore(JSON.parse(raw));
}

function validateStore(data) {
  const objects = data?.objects === undefined ? [] : data.objects;
  if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.cells) ||
      !data.cells.every(c => c && validPosition(c.position) && typeof c.material === 'string' && materials.has(c.material)) ||
      new Set(data.cells.map(c => key(c.position))).size !== data.cells.length || !Array.isArray(objects) ||
      !objects.every(validObject) || new Set(objects.map(o => o.id)).size !== objects.length ||
      !Array.isArray(data.undo) || !data.undo.every(validBatch) || !Array.isArray(data.redo) || !data.redo.every(validBatch)) {
    throw new Error('体素世界文件无效');
  }
  const occupied = new Set(data.cells.map(c => key(c.position))), owned = new Set();
  for (const object of objects) for (const p of object.members || []) {
    const id = key(p);
    if (!occupied.has(id) || owned.has(id)) throw new Error('体素世界的方块归属无效');
    owned.add(id);
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
export function createVoxelWorldStore({ file, snapshot, onSave }) {
  if (typeof file !== 'string' || !file) throw new Error('世界文件路径无效');
  let data = snapshot === undefined ? readStore(file) : validateStore(structuredClone(snapshot));
  const publicState = (value = data) => ({ revision: value.revision, cells: value.cells.map(c => ({ position: [...c.position], material: c.material })),
    objects: value.objects.map(copyObject), canUndo: value.undo.length > 0, canRedo: value.redo.length > 0 });
  const checkRevision = baseRevision => {
    if (!Number.isSafeInteger(baseRevision) || baseRevision !== data.revision) throw new Error('世界版本冲突');
  };
  const prepareCommit = (batch, direction, undo, redo) => {
    const baseRevision = data.revision;
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
    return { state: publicState(next), changes: structuredClone(changes), commit() {
      checkRevision(baseRevision);
      if (onSave) onSave(structuredClone(next));
      else writeStore(file, next);
      data = next;
      return publicState();
    } };
  };
  return {
    state: publicState,
    snapshot: () => structuredClone(data),
    apply(body) { return this.prepare(body).commit(); },
    prepare({ baseRevision, commands }) {
      checkRevision(baseRevision);
      if (!Array.isArray(commands) || !commands.length || commands.length > 128) throw new Error('建造操作无效');
      commands = expandVoxelTools(commands);
      const cellCommands = [], objects = new Map(data.objects.map(o => [o.id, copyObject(o)]));
      for (const command of commands) {
        if (!command || typeof command !== 'object') throw new Error('不支持的建造操作');
        if (command.op === 'object') {
          if (!validObject(command) || command.members !== undefined) throw new Error('对象定义无效；方块归属由建造操作记录');
          objects.set(command.id, { ...copyObject(command),
            ...(objects.get(command.id)?.members === undefined ? {} : { members: objects.get(command.id).members }) });
        } else if (command.op === 'remove-object') {
          if (!validString(command.id)) throw new Error('对象 ID 无效');
          objects.delete(command.id);
        } else cellCommands.push(command);
      }
      const cells = new Map(data.cells.map(c => [key(c.position), c.material]));
      const memberships = new Map([...objects.values()].filter(o => o.members !== undefined).map(o => [o.id, new Set(o.members.map(key))]));
      const owners = new Map();
      for (const [id, members] of memberships) for (const p of members) {
        if (!owners.has(p)) owners.set(p, new Set());
        owners.get(p).add(id);
      }
      let scopedScan = 0;
      const edits = cellCommands.map(command => {
        if (Object.hasOwn(command, 'selection')) throw new Error('不支持直接指定内部选择范围');
        if (command.op !== 'paint-object') return command;
        const object = objects.get(command.id);
        if (!object) throw new Error('找不到要换色的对象');
        const volume = object.from.reduce((n, v, i) => n * (object.to[i] - v + 1), 1);
        scopedScan += volume;
        if (scopedScan > 32768) throw new Error('部件操作扫描范围过大');
        return { op: 'fill', from: object.from, to: object.to, material: command.material, objectId: object.id,
          selection() {
            const members = memberships.get(object.id);
            if (!members) throw new Error('这个部件尚无精确方块归属，请先明确重建该部件，不能按包围范围猜测换色');
            return members;
          } };
      });
      for (const command of edits) if (command.objectId !== undefined && !objects.has(command.objectId)) throw new Error('建造操作引用了未登记的对象');
      const cellChanges = edits.length ? prepareVoxelEdit(edits, p => cells.get(key(p)) ?? null, materials, {
        onWrite(position, command, before, after) {
          const id = key(position), owner = command.objectId;
          if (owner !== undefined && !inside(position, objects.get(owner))) throw new Error('建造操作超出所属对象范围');
          if (owner === undefined && before === after) return;
          for (const old of owners.get(id) || []) if (old !== owner || after === null) memberships.get(old).delete(id);
          owners.set(id, new Set());
          if (owner !== undefined && after !== null) {
            if (!memberships.has(owner)) memberships.set(owner, new Set());
            memberships.get(owner).add(id); owners.get(id).add(owner);
          }
        },
      }) : [];
      for (const [id, members] of memberships) objects.get(id).members = [...members].map(p => p.split(',').map(Number));
      if ([...objects.values()].some(o => !validObject(o))) throw new Error('对象范围与方块归属不一致，请同时修改部件和范围');
      const count = data.cells.length + cellChanges.reduce((n, c) => n + (c.after === null ? -1 : 0) + (c.before === null ? 1 : 0), 0);
      if (count > 5000) throw new Error('方块总数不能超过 5000');
      const beforeObjects = new Map(data.objects.map(o => [o.id, o]));
      const ids = new Set([...beforeObjects.keys(), ...objects.keys()]);
      const objectChanges = [...ids].map(id => ({ id, before: beforeObjects.get(id) ?? null, after: objects.get(id) ?? null }))
        .filter(c => !isDeepStrictEqual(c.before, c.after));
      const changes = { cells: cellChanges, objects: objectChanges };
      if (!cellChanges.length && !objectChanges.length) return { state: publicState(), changes, commit() { checkRevision(baseRevision); return publicState(); } };
      return prepareCommit(changes, 'after', [...data.undo, changes], []);
    },
    undo({ baseRevision }) {
      checkRevision(baseRevision);
      if (!data.undo.length) throw new Error('没有可撤销的操作');
      const changes = data.undo.at(-1);
      return prepareCommit(changes, 'before', data.undo.slice(0, -1), [...data.redo, changes]).commit();
    },
    redo({ baseRevision }) {
      checkRevision(baseRevision);
      if (!data.redo.length) throw new Error('没有可重做的操作');
      const changes = data.redo.at(-1);
      return prepareCommit(changes, 'after', [...data.undo, changes], data.redo.slice(0, -1)).commit();
    },
  };
}
