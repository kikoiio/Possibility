// Backend-independent building commands. Coordinates are integer voxel cells.
const MAX_COORD = 1024;
const MAX_CELLS = 32768;
const MAX_COMMANDS = 128;
const materialPattern = /^[a-z][a-z0-9_.:-]{0,63}$/;
const key = ([x, y, z]) => `${x},${y},${z}`;

function point(value) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(n => Number.isSafeInteger(n) && Math.abs(n) <= MAX_COORD)) {
    throw new Error('坐标必须是范围内的三个整数');
  }
  return value;
}

function material(value) {
  if (typeof value !== 'string' || !materialPattern.test(value)) throw new Error('方块类型无效');
  return value;
}

/** Expand and validate a complete edit before it can touch an engine world.
 * readCell must return a registered material name or null for an empty cell. */
export function prepareVoxelEdit(commands, readCell, allowedMaterials, { onWrite } = {}) {
  if (!Array.isArray(commands) || !commands.length || commands.length > MAX_COMMANDS || typeof readCell !== 'function' || !(allowedMaterials instanceof Set)) {
    throw new Error('建造操作无效');
  }
  const staged = new Map();
  let visited = 0;
  for (const command of commands) {
    if (!command || !['fill', 'replace'].includes(command.op)) throw new Error('不支持的建造操作');
    const from = point(command.from), to = point(command.to);
    if (from.some((n, i) => n > to[i])) throw new Error('区域起点必须小于或等于终点');
    const volume = from.reduce((n, v, i) => n * (to[i] - v + 1), 1);
    visited += volume;
    if (visited > MAX_CELLS) throw new Error('操作范围过大');
    const target = command.material === null ? null : material(command.material);
    if (target !== null && !allowedMaterials.has(target)) throw new Error('方块类型未注册');
    const match = command.op === 'replace' ? (command.match === null ? null : material(command.match)) : undefined;
    if (match !== undefined && match !== null && !allowedMaterials.has(match)) throw new Error('方块类型未注册');
    const selection = typeof command.selection === 'function' ? command.selection() : command.selection;
    for (let x = from[0]; x <= to[0]; x++) for (let y = from[1]; y <= to[1]; y++) for (let z = from[2]; z <= to[2]; z++) {
      const position = [x, y, z], id = key(position), entry = staged.get(id);
      if (selection && !selection.has(id)) continue;
      const current = entry ? entry.after : readCell(position);
      if (current !== null && (typeof current !== 'string' || !allowedMaterials.has(current))) throw new Error('无法读取已加载的方块');
      if (command.op === 'replace' && current !== match) continue;
      onWrite?.(position, command, current, target);
      if (entry) entry.after = target;
      else staged.set(id, { position, before: current, after: target });
    }
  }
  return [...staged.values()].filter(entry => entry.before !== entry.after);
}
