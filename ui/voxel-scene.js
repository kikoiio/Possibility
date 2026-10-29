import * as THREE from '/vendor/three.module.js';

// Positions identify unit cells by their minimum corner. Unknown materials get a
// stable color. Transparent materials retain their visible boundaries.
const CHUNK = 16;
const key = (x, y, z) => `${x},${y},${z}`;
const chunkKey = (x, y, z) => key(Math.floor(x / CHUNK), Math.floor(y / CHUNK), Math.floor(z / CHUNK));
const palette = {
  grass: 0x78a75b, dirt: 0x866346, soil: 0x866346, stone: 0x93999b,
  wood: 0x9d744c, sand: 0xd8c58f, brick: 0xb96e5a, leaves: 0x548b61,
  water: 0x5594b4, glass: 0xa6cbd0, snow: 0xe7eef0, roof: 0x945d50,
};
const faces = [
  { d: [1, 0, 0], n: [1, 0, 0], v: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]] },
  { d: [-1, 0, 0], n: [-1, 0, 0], v: [[0,0,1],[0,1,1],[0,1,0],[0,0,0]] },
  { d: [0, 1, 0], n: [0, 1, 0], v: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]] },
  { d: [0, -1, 0], n: [0, -1, 0], v: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]] },
  { d: [0, 0, 1], n: [0, 0, 1], v: [[1,0,1],[1,1,1],[0,1,1],[0,0,1]] },
  { d: [0, 0, -1], n: [0, 0, -1], v: [[0,0,0],[0,1,0],[1,1,0],[1,0,0]] },
];

function colorFor(name) {
  if (Object.hasOwn(palette, name)) return palette[name];
  let hash = 2166136261;
  for (const c of name) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return new THREE.Color().setHSL((hash >>> 0) / 4294967296, 0.32, 0.56);
}

function readCells(world) {
  if (!world || !Array.isArray(world.cells) || !Array.isArray(world.objects)) throw new TypeError('world requires cells and objects arrays');
  const cells = new Map();
  for (const cell of world.cells) {
    const p = cell?.position;
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isSafeInteger) || typeof cell.material !== 'string' || !cell.material) {
      throw new TypeError('each cell requires three integer coordinates and a material');
    }
    const id = key(...p);
    if (cells.has(id)) throw new TypeError(`duplicate cell: ${id}`);
    cells.set(id, { position: [...p], material: cell.material });
  }
  return cells;
}

/** Mount a voxel view. Call update with a complete snapshot and dispose on unmount. */
export async function createVoxelScene(host, initialWorld) {
  if (!host?.appendChild) throw new TypeError('host must be an element');
  let cells = readCells(initialWorld);
  let latestWorld = initialWorld, cutawayEnabled = false;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x182126);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 10000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
  host.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xeaf8ff, 0x8a8874, 1.65));
  const sun = new THREE.DirectionalLight(0xffefd7, 2);
  sun.position.set(8, 14, 10); scene.add(sun);
  const chunks = new Map(), materials = new Map(), textures = new Map();
  const people = new THREE.Group(); scene.add(people);
  // A simple backdrop gives the model a visual base without adding world cells.
  const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 64),
    new THREE.MeshStandardMaterial({ color: 0x353c40, roughness: 1, side: THREE.DoubleSide }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const target = new THREE.Vector3();
  let radius = 20, azimuth = Math.PI / 4, polar = Math.PI / 3;
  let disposed = false, frame = 0;
  const pointers = new Map();
  let pinchDistance = 0;

  function materialFor(name) {
    if (materials.has(name)) return materials.get(name);
    // Created only when a scene is mounted; importing this module needs no DOM.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d');
    const transparent = name === 'glass' || name === 'water';
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 32, 32);
    // A deterministic, low-contrast pixel pattern keeps large surfaces readable.
    let seed = 2166136261;
    for (const c of name) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619);
    for (let i = 0; i < (transparent ? 5 : 28); i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const x = 2 + (seed % 7) * 4, y = 2 + ((seed >>> 8) % 7) * 4;
      ctx.fillStyle = i % 3 ? 'rgba(55,45,35,0.055)' : 'rgba(255,255,255,0.24)';
      ctx.fillRect(x, y, 3, 3);
    }
    ctx.strokeStyle = transparent ? 'rgba(40,100,110,0.5)' : 'rgba(40,35,30,0.19)';
    ctx.lineWidth = transparent ? 2 : 1;
    ctx.strokeRect(0.5, 0.5, 31, 31);
    if (name === 'glass') {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(5, 5, 3, 12); ctx.fillRect(8, 5, 9, 3);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestMipmapNearestFilter;
    textures.set(name, texture);
    const material = new THREE.MeshStandardMaterial({
      color: colorFor(name), map: texture, vertexColors: true, roughness: transparent ? 0.35 : 0.9,
      transparent, opacity: name === 'glass' ? 0.42 : name === 'water' ? 0.72 : 1,
      depthWrite: !transparent,
    });
    materials.set(name, material);
    return material;
  }
  function requestRender() {
    if (!disposed && !frame) frame = requestAnimationFrame(render);
  }
  function render() {
    frame = 0;
    if (disposed) return;
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height; camera.updateProjectionMatrix();
    camera.position.set(target.x + radius * Math.sin(polar) * Math.sin(azimuth), target.y + radius * Math.cos(polar), target.z + radius * Math.sin(polar) * Math.cos(azimuth));
    camera.lookAt(target);
    renderer.render(scene, camera);
  }
  function removeChunk(id) {
    const group = chunks.get(id);
    if (!group) return;
    scene.remove(group);
    for (const mesh of group.children) mesh.geometry.dispose();
    chunks.delete(id);
  }
  function buildChunk(id, members) {
    removeChunk(id);
    if (!members?.length) return;
    const buffers = new Map();
    for (const { position: [x, y, z], material } of members) {
      for (const face of faces) {
        const neighbor = cells.get(key(x + face.d[0], y + face.d[1], z + face.d[2]));
        const transparent = material === 'glass' || material === 'water';
        const neighborTransparent = neighbor && (neighbor.material === 'glass' || neighbor.material === 'water');
        if (neighbor && (!neighborTransparent || neighbor.material === material ||
            (transparent && material > neighbor.material))) continue;
        if (!buffers.has(material)) buffers.set(material, { positions: [], normals: [], uvs: [], colors: [], indices: [] });
        const buffer = buffers.get(material), base = buffer.positions.length / 3;
        const hash = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
        const shade = 0.94 + (hash % 13) / 100;
        for (let i = 0; i < 4; i++) {
          const v = face.v[i];
          buffer.positions.push(x + v[0], y + v[1], z + v[2]); buffer.normals.push(...face.n);
          buffer.uvs.push(...[[0, 0], [0, 1], [1, 1], [1, 0]][i]);
          buffer.colors.push(shade, shade, shade);
        }
        buffer.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    const group = new THREE.Group();
    for (const [name, data] of buffers) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));
      geometry.setIndex(data.indices); geometry.computeBoundingSphere();
      group.add(new THREE.Mesh(geometry, materialFor(name)));
    }
    scene.add(group); chunks.set(id, group);
  }
  function rebuild(ids) {
    const members = new Map();
    for (const cell of cells.values()) {
      const id = chunkKey(...cell.position);
      if (ids.has(id)) { if (!members.has(id)) members.set(id, []); members.get(id).push(cell); }
    }
    for (const id of ids) buildChunk(id, members.get(id));
    requestRender();
  }
  function frameWorld(reframe = true) {
    if (!cells.size) { ground.visible = false; return; }
    ground.visible = true;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const { position } of cells.values()) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], position[i]); max[i] = Math.max(max[i], position[i] + 1); }
    const center = min.map((v, i) => (v + max[i]) / 2);
    const extent = Math.hypot(...min.map((v, i) => max[i] - v));
    const aspect = Math.max(0.25, host.clientWidth / Math.max(1, host.clientHeight));
    if (reframe) {
      target.set(...center);
      radius = Math.max(5, extent * 1.5 / Math.min(1, aspect));
      camera.far = Math.max(10000, radius * 10);
    }
    ground.position.set(center[0], min[1] - 0.04, center[2]);
    ground.scale.setScalar(Math.max(8, extent * 1.5));
  }
  function update(world) {
    if (disposed) return;
    latestWorld = world;
    const next = readCells(world), dirty = new Set();
    if (cutawayEnabled) {
      const roofs = world.objects.filter(o => o.kind === 'roof');
      for (const [id, cell] of next) if (cell.material === 'roof' || roofs.some(o => cell.position.every((v, i) => v >= o.from[i] && v <= o.to[i]))) next.delete(id);
    }
    for (const id of new Set([...cells.keys(), ...next.keys()])) {
      const old = cells.get(id), current = next.get(id);
      if (old?.material === current?.material) continue;
      const [x, y, z] = (current || old).position;
      dirty.add(chunkKey(x, y, z));
      for (const { d } of faces) dirty.add(chunkKey(x + d[0], y + d[1], z + d[2]));
    }
    const wasEmpty = cells.size === 0;
    cells = next;
    frameWorld(wasEmpty);
    rebuild(dirty);
    updatePeople(world.actors || []);
  }
  function clearPeople() {
    people.traverse(object => { object.geometry?.dispose(); if (object.material) { object.material.map?.dispose(); object.material.dispose(); } });
    people.clear();
  }
  function updatePeople(actors) {
    clearPeople();
    for (const actor of actors) {
      if (!Array.isArray(actor.position) || actor.position.length !== 3 || !actor.position.every(Number.isFinite)) continue;
      const person = new THREE.Group(); person.position.set(...actor.position);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.85, 6), new THREE.MeshStandardMaterial({ color: 0x71c6bd, roughness: 0.85 }));
      body.position.y = 0.6;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), new THREE.MeshStandardMaterial({ color: 0xe1b989 })); head.position.y = 1.25;
      person.add(body, head);
      const label = document.createElement('canvas'); label.width = 256; label.height = 64;
      const ctx = label.getContext('2d');
      ctx.fillStyle = '#13242be6'; ctx.fillRect(0, 0, 256, 64); ctx.fillStyle = '#eaf8ff'; ctx.textAlign = 'center'; ctx.font = '24px sans-serif'; ctx.fillText(String(actor.name || '').slice(0, 10), 128, 42);
      const texture = new THREE.CanvasTexture(label); texture.colorSpace = THREE.SRGBColorSpace;
      const name = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false })); name.position.y = 1.9; name.scale.set(2.6, 0.65, 1); person.add(name);
      people.add(person);
    }
    requestRender();
  }
  function resetView() { azimuth = Math.PI / 4; polar = Math.PI / 3; frameWorld(); requestRender(); }
  function cutaway(enabled) { cutawayEnabled = Boolean(enabled); update(latestWorld); }
  let controls;
  if (host.parentElement?.id !== 'voxel-scene') {
    controls = document.createElement('div'); controls.className = 'voxel-view-controls';
    const reset = document.createElement('button'), interior = document.createElement('button');
    reset.type = interior.type = 'button'; reset.textContent = '看全景'; interior.textContent = '查看室内';
    interior.setAttribute('aria-pressed', 'false');
    reset.addEventListener('click', resetView);
    interior.addEventListener('click', () => { cutaway(!cutawayEnabled); interior.textContent = cutawayEnabled ? '显示屋顶' : '查看室内'; interior.setAttribute('aria-pressed', String(cutawayEnabled)); });
    controls.append(reset, interior); host.appendChild(controls);
  }
  function pointerDown(event) {
    if (event.pointerType === 'mouse' && ![0, 1].includes(event.button)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pan: event.button === 1 || event.shiftKey });
    renderer.domElement.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      const [a, b] = pointers.values();
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }
  function pointerMove(event) {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    if (pointers.size === 1 && !point.pan) {
      azimuth -= (event.clientX - point.x) * 0.008;
      polar = Math.max(0.08, Math.min(Math.PI - 0.08, polar - (event.clientY - point.y) * 0.008));
    } else if (pointers.size === 1 && point.pan) {
      const dx = event.clientX - point.x, dy = event.clientY - point.y;
      const scale = radius / Math.max(160, host.clientHeight) * 1.15;
      target.x -= (Math.cos(azimuth) * dx - Math.sin(azimuth) * dy * 0.35) * scale;
      target.z -= (Math.sin(azimuth) * dx + Math.cos(azimuth) * dy * 0.35) * scale;
    }
    point.x = event.clientX; point.y = event.clientY;
    if (pointers.size === 2) {
      const [a, b] = pointers.values();
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0 && distance > 0) radius = Math.max(2, Math.min(5000, radius * pinchDistance / distance));
      pinchDistance = distance;
    }
    requestRender();
  }
  function pointerEnd(event) { pointers.delete(event.pointerId); pinchDistance = 0; }
  function wheel(event) {
    event.preventDefault(); radius = Math.max(2, Math.min(5000, radius * Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.001))))); requestRender();
  }
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerEnd); canvas.addEventListener('pointercancel', pointerEnd);
  canvas.addEventListener('lostpointercapture', pointerEnd); canvas.addEventListener('wheel', wheel, { passive: false });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(requestRender) : null;
  observer?.observe(host); window.addEventListener('resize', requestRender);
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    observer?.disconnect(); window.removeEventListener('resize', requestRender);
    canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointermove', pointerMove);
    canvas.removeEventListener('pointerup', pointerEnd); canvas.removeEventListener('pointercancel', pointerEnd);
    canvas.removeEventListener('lostpointercapture', pointerEnd); canvas.removeEventListener('wheel', wheel);
    for (const id of [...chunks.keys()]) removeChunk(id);
    for (const material of materials.values()) material.dispose();
    for (const texture of textures.values()) texture.dispose();
    clearPeople(); controls?.remove();
    ground.geometry.dispose(); ground.material.dispose();
    materials.clear(); textures.clear(); pointers.clear(); renderer.dispose(); canvas.remove(); cells.clear();
  }
  try {
    frameWorld(); rebuild(new Set([...cells.values()].map(cell => chunkKey(...cell.position))));
    updatePeople(initialWorld.actors || []);
  } catch (error) { dispose(); throw error; }
  return { update, dispose, frame: resetView, cutaway };
}
