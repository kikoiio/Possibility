// The output fits the existing voxel edit budget without needing world state.
const MAX_COMMANDS = 128;
const MAX_SCAN = 32768;
const materialPattern = /^[a-z][a-z0-9_.:-]{0,63}$/;
const validString = value => typeof value === 'string' && value.length <= 256 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);

function bounds(command) {
  for (const point of [command.from, command.to]) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(n => Number.isSafeInteger(n) && Math.abs(n) <= 1024)) {
      throw new Error('坐标必须是范围内的三个整数');
    }
  }
  if (command.from.some((n, i) => n > command.to[i])) throw new Error('区域起点必须小于或等于终点');
}

function checkMaterial(value) {
  if (value !== null && (typeof value !== 'string' || !materialPattern.test(value))) throw new Error('方块类型无效');
}

/**
 * Expand high-level commands into bounded, non-overlapping fill boxes.
 * Roof: at each x the surface is one voxel thick, at y = from.y +
 * min(x - from.x, to.x - x, to.y - from.y), extending along z.
 * Thus to.y is an inclusive height cap, and a low cap creates a flat ridge.
 * Base commands are retained unchanged; material registration is engine-specific.
 */
export function expandVoxelTools(commands) {
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_COMMANDS) throw new Error('建造操作无效');
  const result = [];
  let scan = 0;
  function append(command, countCells = false) {
    if (result.length >= MAX_COMMANDS) throw new Error('展开指令数量超限');
    if (countCells) {
      const volume = command.from.reduce((n, v, i) => n * (command.to[i] - v + 1), 1);
      if (volume > MAX_SCAN - scan) throw new Error('操作扫描范围过大');
      scan += volume;
    }
    result.push(command);
  }
  for (const command of commands) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('不支持的建造操作');
    const { op } = command;
    if (op === 'copy') throw new Error('copy 需要当前世界，无法展开');
    if (op === 'remove-object') {
      if (!validString(command.id)) throw new Error('对象 ID 无效');
      append(command);
      continue;
    }
    if (!['fill', 'replace', 'object', 'walls', 'roof', 'hollow'].includes(op)) throw new Error('不支持的建造操作');
    bounds(command);
    if (op === 'object') {
      if (![command.id, command.name, command.kind].every(validString)) throw new Error('对象定义无效');
      append(command);
      continue;
    }
    checkMaterial(command.material);
    if (op === 'replace') checkMaterial(command.match);
    if (op === 'fill' || op === 'replace') {
      append(command, true);
      continue;
    }
    const [x0, y0, z0] = command.from, [x1, y1, z1] = command.to;
    const fill = (xa, ya, za, xb, yb, zb) => {
      if (xa > xb || ya > yb || za > zb) return;
      append({ op: 'fill', from: [xa, ya, za], to: [xb, yb, zb], material: command.material }, true);
    };
    if (op === 'roof') {
      for (let x = x0; x <= x1; x++) {
        const y = y0 + Math.min(x - x0, x1 - x, y1 - y0);
        fill(x, y, z0, x, y, z1);
      }
      continue;
    }
    // X faces include corners; Z faces cover only the remaining interior X.
    fill(x0, y0, z0, x0, y1, z1);
    if (x1 > x0) fill(x1, y0, z0, x1, y1, z1);
    fill(x0 + 1, y0, z0, x1 - 1, y1, z0);
    if (z1 > z0) fill(x0 + 1, y0, z1, x1 - 1, y1, z1);
    if (op === 'hollow') {
      // Add the floor and ceiling only where the walls have not already filled.
      fill(x0 + 1, y0, z0 + 1, x1 - 1, y0, z1 - 1);
      if (y1 > y0) fill(x0 + 1, y1, z0 + 1, x1 - 1, y1, z1 - 1);
    }
  }
  return result;
}
