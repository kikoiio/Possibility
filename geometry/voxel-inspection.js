const key = p => p.join(',');
const within = (p, o) => p.every((n, i) => n >= o.from[i] && n <= o.to[i]);
const solid = material => material !== undefined && material !== 'water';

// Deliberately limited to the current single-level rectangular building contract:
// from.y is the floor. Findings are advisory during incremental construction.
// No visual judgement, arbitrary geometry, stairs or physics is inferred here.
export function inspectVoxelSpaces(world) {
  const objects = world?.objects || [], cells = new Map((world?.cells || []).map(c => [key(c.position), c.material]));
  const issues = [], buildings = [];
  const add = (object, code, message) => issues.push({ objectId: object.id, code, message: `${object.name}：${message}` });
  const read = (x, y, z) => cells.get(`${x},${y},${z}`);
  const standing = (x, floor, z) => solid(read(x, floor, z)) && !read(x, floor + 1, z) && !read(x, floor + 2, z);
  const roofs = objects.filter(o => o.kind === 'roof');
  const roofCells = new Set();
  for (const roof of roofs) {
    // A legacy roof-colored voxel is explicit; arbitrary wood in a legacy box is not.
    const positions = roof.members ?? (world.cells || []).filter(c => c.material === 'roof' && within(c.position, roof)).map(c => c.position);
    for (const p of positions) if (solid(cells.get(key(p)))) roofCells.add(key(p));
  }
  for (const object of objects.filter(o => o.kind === 'building')) {
    const [x0, floor, z0] = object.from, [x1, top, z1] = object.to;
    const area = (x1 - x0 + 3) * (z1 - z0 + 3);
    if (x1 - x0 < 2 || z1 - z0 < 2 || top - floor < 3 || area * (top - floor + 1) > 32768) {
      add(object, 'unsupported-building', '当前范围不适合单层矩形建筑检查，尚未验证可进入空间。');
      continue;
    }
    let walkableCells = 0, entrances = 0, roofGaps = 0, wallGaps = 0, floorGaps = 0;
    for (let x = x0 + 1; x < x1; x++) for (let z = z0 + 1; z < z1; z++) {
      if (!solid(read(x, floor, z))) floorGaps++;
      if (standing(x, floor, z)) walkableCells++;
      let covered = false;
      for (let y = floor + 3; y <= top + 1; y++) if (roofCells.has(`${x},${y},${z}`)) { covered = true; break; }
      if (!covered) roofGaps++;
    }
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      if (x !== x0 && x !== x1 && z !== z0 && z !== z1) continue;
      if (!solid(read(x, floor + 3, z))) wallGaps++;
      const direction = x === x0 && z > z0 && z < z1 ? [-1, 0] : x === x1 && z > z0 && z < z1 ? [1, 0]
        : z === z0 && x > x0 && x < x1 ? [0, -1] : z === z1 && x > x0 && x < x1 ? [0, 1] : null;
      if (direction && standing(x, floor, z) && standing(x + direction[0], floor, z + direction[1]) &&
          standing(x - direction[0], floor, z - direction[1])) entrances++;
    }
    if (!walkableCells) add(object, 'no-headroom', '没有同时具备地板和两格净空的室内位置，请先清出可站立空间。');
    if (!entrances) add(object, 'no-entrance', '没有检测到连接室内与室外地面的两格高门洞。');
    if (floorGaps) add(object, 'floor-gap', `室内有 ${floorGaps} 处缺少实心地板。`);
    if (wallGaps) add(object, 'wall-gap', `墙顶高度有 ${wallGaps} 处开口，请检查墙体与屋顶衔接。`);
    if (roofGaps) add(object, 'roof-gap', `有 ${roofGaps} 列室内范围没有可确认的屋顶覆盖。`);
    if ((world.cells || []).some(c => c.material === 'water' && within(c.position, object))) add(object, 'water-inside', '水与建筑范围相交，请检查水面是否穿过地板或室内。');
    buildings.push({ objectId: object.id, walkableCells, entrances, floorGaps, wallGaps, roofGaps });
  }
  for (const window of objects.filter(o => o.kind === 'window')) {
    if (!window.members?.length) {
      add(window, 'window-unverified', '没有精确玻璃归属，尚不能确认窗户嵌在外墙。');
      continue;
    }
    const embedded = window.members.every(p => cells.get(key(p)) === 'glass' && objects.some(o => {
      if (o.kind !== 'building' || !within(p, o) || p[1] <= o.from[1]) return false;
      const faceX = p[0] === o.from[0] || p[0] === o.to[0], faceZ = p[2] === o.from[2] || p[2] === o.to[2];
      if (!faceX && !faceZ) return false;
      const offsets = [[0, 1, 0], [0, -1, 0], ...(faceX ? [[0, 0, 1], [0, 0, -1]] : [[1, 0, 0], [-1, 0, 0]])];
      return offsets.some(d => { const q = p.map((v, i) => v + d[i]); return within(q, o) && solid(cells.get(key(q))) && cells.get(key(q)) !== 'glass'; });
    }));
    if (!embedded) add(window, 'window-detached', '玻璃与外墙位置或支撑不一致，请检查窗户是否悬空。');
  }
  return { scope: 'single-level-rectangular', buildings, issues };
}
