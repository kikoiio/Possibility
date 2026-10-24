/** Throwaway comparison prototype. Native ES module; no dependencies. */
export function createStage(host, mode) {
  if (!host || typeof host.appendChild !== 'function') throw new TypeError('createStage needs a host element');
  if (mode !== '2d' && mode !== '3d') throw new TypeError("mode must be '2d' or '3d'");
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  let disposed = false;
  let frame = 0;
  let width = 0;
  let height = 0;
  let scene = { revisionId: '', worldTime: 0, locations: [], characters: [] };
  let bounds = getBounds(scene);
  let geometryDirty = true;
  let labels = [];
  let occupied = [];
  let yaw = -0.65;
  let elevation = 0.75;
  let zoom = 1;
  let drag = null;
  let gpu = null;
  let contextLost = false;

  const root = node('div', host);
  root.style.cssText = 'position:relative;width:100%;height:100%;min-width:0;overflow:hidden;background:#f5efe4;color:#3c433d;font:12px/1.4 system-ui,sans-serif;isolation:isolate;';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', mode === '2d' ? '小镇二维俯视图' : '小镇三维空间图');
  const canvas = node('canvas', root);
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  canvas.setAttribute('aria-label', mode === '2d' ? '二维小镇，名称与坐标见辅助列表' : 'WebGL 三维小镇，可拖动旋转、滚轮缩放');
  const labelLayer = node('div', root);
  labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;';
  labelLayer.setAttribute('aria-hidden', 'true');
  const badge = node('div', root);
  badge.style.cssText = 'position:absolute;top:12px;left:12px;max-width:calc(100% - 24px);padding:7px 10px;border:1px solid #ded8ca;border-radius:9px;background:#fffaf0ed;pointer-events:none;white-space:pre-line;overflow-wrap:anywhere;z-index:2;';
  const hint = node('div', root);
  hint.textContent = mode === '3d' ? '拖动旋转 · 滚轮缩放 · 方向键旋转 · +/- 缩放 · Home 复位' : '俯视图 · 横轴 X / 纵轴 Z';
  hint.style.cssText = 'position:absolute;right:10px;bottom:10px;max-width:65%;padding:5px 8px;border-radius:6px;background:#fffaf0e8;color:#62685d;font-size:11px;pointer-events:none;text-align:right;z-index:2;';
  const details = node('details', root);
  details.style.cssText = 'position:absolute;left:10px;bottom:10px;max-width:80%;border:1px solid #ded8ca;border-radius:7px;background:#fffaf0f5;z-index:3;';
  const summary = node('summary', details);
  summary.textContent = '名称与坐标';
  summary.style.cssText = 'padding:6px 9px;cursor:pointer;';
  const inventory = node('div', details);
  inventory.style.cssText = 'padding:0 10px 8px;max-height:160px;overflow:auto;white-space:pre-line;';
  const notice = node('div', root);
  notice.setAttribute('role', 'status');
  notice.style.cssText = 'display:none;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:max-content;max-width:80%;padding:16px;border:1px solid #d8c6b2;border-radius:12px;background:#fffaf0;text-align:center;white-space:pre-line;z-index:4;';

  let gl = null;
  let ctx = null;
  if (mode === '2d') {
    ctx = canvas.getContext('2d');
    if (!ctx) showNotice('Canvas2D 不可用，无法显示二维视图。');
  } else {
    canvas.tabIndex = 0;
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    try {
      gl = canvas.getContext('webgl', { antialias: true, alpha: false }) || canvas.getContext('experimental-webgl', { antialias: true, alpha: false });
      if (gl) gpu = makeGPU(gl);
      else showNotice('WebGL 不可用\n此浏览器无法显示真正的三维视图。');
    } catch (error) {
      showNotice(`WebGL 三维初始化失败\n${error.message}`);
    }
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerEnd);
    canvas.addEventListener('pointercancel', pointerEnd);
    canvas.addEventListener('lostpointercapture', pointerEnd);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('keydown', keyDown);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
  }

  const observer = new win.ResizeObserver(schedule);
  observer.observe(root);
  // DPR can change when moving this page between screens.
  win.addEventListener('resize', schedule);
  update(scene);

  return { update, dispose };

  function node(tag, parent) {
    const el = doc.createElement(tag);
    parent.appendChild(el);
    return el;
  }

  function showNotice(message) {
    notice.textContent = message;
    notice.style.display = message ? 'block' : 'none';
  }

  function update(next) {
    if (disposed) return;
    // Snapshot values so two stages never mutate a shared scene or its objects.
    scene = {
      revisionId: String(next.revisionId ?? ''),
      worldTime: finite(next.worldTime, 0),
      locations: next.locations.map(item => ({ ...item })),
      characters: next.characters.map(item => ({ ...item })),
    };
    bounds = getBounds(scene);
    geometryDirty = true;
    root.dataset.revisionId = scene.revisionId;
    root.dataset.worldTime = String(scene.worldTime);
    const minutes = Math.floor(scene.worldTime);
    badge.textContent = `${mode === '2d' ? '2D · 俯视' : '3D · 空间'} · 第${Math.floor(minutes / 1440) + 1}天 ${String(Math.floor(minutes % 1440 / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    labelLayer.replaceChildren();
    labels = [];
    const lines = [];
    for (const [kind, items] of [['location', scene.locations], ['character', scene.characters]]) {
      for (const item of items) {
        const name = String(item.name ?? item.id ?? '未命名');
        const x = finite(item.x, 0);
        const z = finite(item.z, 0);
        const label = node('div', labelLayer);
        label.style.cssText = `position:absolute;left:0;top:0;transform:translate(-50%,-100%);padding:3px 6px;border-radius:6px;border:1px solid ${kind === 'character' ? '#9aab9b' : '#ded7c9'};background:${kind === 'character' ? '#ffffffed' : '#fff9eceb'};color:#303d38;text-align:center;white-space:nowrap;font-size:11px;box-shadow:0 1px 3px #3c433d16;`;
        const title = node('div', label);
        title.textContent = name;
        title.style.fontWeight = kind === 'character' ? '700' : '600';
        const position = node('div', label);
        position.textContent = `${format(x)}, ${format(z)}`;
        position.style.cssText = 'display:none;';
        labels.push({ el: label, x, z, y: kind === 'location' ? buildingHeight(item) + 1 : 7.7, kind });
        lines.push(`${kind === 'location' ? '建筑' : '角色'} · ${name} — X ${format(x)}, Z ${format(z)}${kind === 'location' ? ` · 高 ${format(buildingHeight(item))}` : ''}`);
      }
    }
    inventory.textContent = lines.join('\n') || '当前场景为空';
    schedule();
  }

  function schedule() {
    if (!disposed && !frame) frame = win.requestAnimationFrame(render);
  }

  function render() {
    frame = 0;
    if (disposed) return;
    const rect = root.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    if (width <= 0 || height <= 0) return;
    occupied = [];
    const dpr = Math.min(win.devicePixelRatio || 1, 2);
    const maxSize = gl && !contextLost ? Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096, 4096) : 4096;
    const ratio = Math.min(dpr, maxSize / width, maxSize / height);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    if (mode === '2d' && ctx) draw2D();
    else if (gl && gpu && !contextLost) draw3D();
    else for (const label of labels) label.el.style.display = 'none';
  }

  function draw2D() {
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    ctx.fillStyle = '#f5efe4';
    ctx.fillRect(0, 0, width, height);
    const scale = Math.max(0.001, Math.min(Math.max(1, width - 70) / bounds.w, Math.max(1, height - 140) / bounds.d));
    const px = x => width / 2 + (x - bounds.cx) * scale;
    const pz = z => height / 2 + 12 + (z - bounds.cz) * scale;
    const plane = (x, z, w, d, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(px(x - w / 2), pz(z - d / 2), w * scale, d * scale);
    };
    for (const item of landscape(bounds)) plane(item.x, item.z, item.w, item.d, item.color);
    ctx.strokeStyle = '#b4b89d55';
    ctx.lineWidth = 1;
    for (let x = Math.ceil(bounds.minX / 10) * 10; x <= bounds.maxX; x += 10) {
      ctx.beginPath(); ctx.moveTo(px(x), pz(bounds.minZ)); ctx.lineTo(px(x), pz(bounds.maxZ)); ctx.stroke();
    }
    for (let z = Math.ceil(bounds.minZ / 10) * 10; z <= bounds.maxZ; z += 10) {
      ctx.beginPath(); ctx.moveTo(px(bounds.minX), pz(z)); ctx.lineTo(px(bounds.maxX), pz(z)); ctx.stroke();
    }
    for (const item of scene.locations) {
      const x = finite(item.x, 0), z = finite(item.z, 0);
      const w = dimension(item.width, 10), d = dimension(item.depth, 8);
      const left = px(x - w / 2), top = pz(z - d / 2);
      ctx.fillStyle = '#6a624526';
      ctx.fillRect(left + 3, top + 4, w * scale, d * scale);
      ctx.fillStyle = hex(item.color, '#cf9b76');
      ctx.fillRect(left, top, w * scale, d * scale);
      ctx.strokeStyle = '#544e4277';
      ctx.strokeRect(left, top, w * scale, d * scale);
      ctx.fillStyle = '#fff9e760';
      ctx.fillRect(left + 2, top + 2, Math.max(0, w * scale - 4), Math.min(3, d * scale / 4));
    }
    for (const item of scene.characters) {
      const x = px(finite(item.x, 0)), z = pz(finite(item.z, 0));
      ctx.beginPath(); ctx.arc(x, z, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#fffaf0'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, z, 5, 0, Math.PI * 2);
      ctx.fillStyle = hex(item.color, '#547c76'); ctx.fill();
      ctx.strokeStyle = '#33493d'; ctx.lineWidth = 1; ctx.stroke();
    }
    for (const label of labels) {
      const offset = label.kind === 'character' ? 11 : 4;
      placeLabel(label, px(label.x), pz(label.z) - offset, true);
    }
  }

  function draw3D() {
    if (geometryDirty) {
      const data = geometry(scene, bounds);
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gpu.count = data.length / 9;
      geometryDirty = false;
    }
    const radius = Math.hypot(bounds.w, bounds.d, bounds.h) / 2;
    const target = [bounds.cx, bounds.h * 0.3, bounds.cz];
    const fov = Math.PI / 4;
    const aspect = width / height;
    const halfAngle = Math.min(fov / 2, Math.atan(Math.tan(fov / 2) * aspect));
    const distance = radius / Math.sin(halfAngle) * zoom * 1.12;
    const eye = [target[0] + Math.sin(yaw) * Math.cos(elevation) * distance,
      target[1] + Math.sin(elevation) * distance,
      target[2] + Math.cos(yaw) * Math.cos(elevation) * distance];
    const matrix = multiply(perspective(fov, aspect, Math.max(0.1, distance / 1000), distance + radius * 6), lookAt(eye, target));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.961, 0.937, 0.894, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(gpu.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.buffer);
    for (const [attribute, offset] of [[gpu.position, 0], [gpu.normal, 12], [gpu.color, 24]]) {
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 36, offset);
    }
    gl.uniformMatrix4fv(gpu.matrix, false, matrix);
    gl.drawArrays(gl.TRIANGLES, 0, gpu.count);
    for (const label of labels) {
      const p = project(matrix, label.x, label.y, label.z);
      placeLabel(label, (p[0] + 1) * width / 2, (1 - p[1]) * height / 2 - 4, p[3] > 0 && p[2] >= -1 && p[2] <= 1);
    }
  }

  function placeLabel(label, x, y, visible) {
    label.el.style.display = visible && x > 0 && x < width && y > 0 && y < height ? 'block' : 'none';
    if (label.el.style.display === 'none') return;
    const w = label.el.offsetWidth, h = label.el.offsetHeight;
    x = clamp(x, w / 2 + 3, width - w / 2 - 3);
    for (let n = 0; n < 12; n++) {
      const box = { left: x - w / 2, right: x + w / 2, top: y - h, bottom: y };
      if (!occupied.some(b => box.left < b.right + 3 && box.right > b.left - 3 && box.top < b.bottom + 3 && box.bottom > b.top - 3)) break;
      y -= h + 3;
      if (y < 55) { x = clamp(x + w + 4, w / 2 + 3, width - w / 2 - 3); y = 90 + n * 3; }
    }
    occupied.push({ left: x - w / 2, right: x + w / 2, top: y - h, bottom: y });
    label.el.style.left = `${x}px`;
    label.el.style.top = `${y}px`;
    label.el.style.zIndex = label.kind === 'character' ? '2' : '1';
  }

  function pointerDown(event) {
    if (event.button !== 0 || !gpu || contextLost || drag) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.focus({ preventScroll: true });
    canvas.style.cursor = 'grabbing';
  }

  function pointerMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    yaw -= (event.clientX - drag.x) * 0.008;
    elevation = clamp(elevation + (event.clientY - drag.y) * 0.006, 0.18, 1.43);
    drag.x = event.clientX;
    drag.y = event.clientY;
    schedule();
  }

  function pointerEnd(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const id = drag.id;
    drag = null;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    canvas.style.cursor = 'grab';
  }

  function wheel(event) {
    if (!gpu || contextLost) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
    zoom = clamp(zoom * Math.exp(clamp(delta, -300, 300) * 0.0015), 0.35, 3);
    schedule();
  }

  function keyDown(event) {
    if (!gpu || contextLost) return;
    if (event.key === 'ArrowLeft') yaw -= 0.12;
    else if (event.key === 'ArrowRight') yaw += 0.12;
    else if (event.key === 'ArrowUp') elevation = clamp(elevation + 0.08, 0.18, 1.43);
    else if (event.key === 'ArrowDown') elevation = clamp(elevation - 0.08, 0.18, 1.43);
    else if (event.key === '+' || event.key === '=') zoom = clamp(zoom * 0.9, 0.35, 3);
    else if (event.key === '-') zoom = clamp(zoom / 0.9, 0.35, 3);
    else if (event.key === 'Home') { yaw = -0.65; elevation = 0.75; zoom = 1; }
    else return;
    event.preventDefault();
    schedule();
  }

  function lost(event) {
    event.preventDefault();
    contextLost = true;
    gpu = null;
    showNotice('WebGL 上下文已丢失\n等待浏览器恢复三维视图。');
    schedule();
  }

  function restored() {
    if (disposed) return;
    try {
      gpu = makeGPU(gl);
      contextLost = false;
      geometryDirty = true;
      showNotice('');
    } catch (error) {
      showNotice(`WebGL 恢复失败\n${error.message}`);
    }
    schedule();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    observer.disconnect();
    win.removeEventListener('resize', schedule);
    canvas.removeEventListener('pointerdown', pointerDown);
    canvas.removeEventListener('pointermove', pointerMove);
    canvas.removeEventListener('pointerup', pointerEnd);
    canvas.removeEventListener('pointercancel', pointerEnd);
    canvas.removeEventListener('lostpointercapture', pointerEnd);
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('keydown', keyDown);
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', restored);
    if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
    drag = null;
    if (gl) {
      if (gpu) { gl.deleteBuffer(gpu.buffer); gl.deleteProgram(gpu.program); }
      const extension = gl.getExtension('WEBGL_lose_context');
      if (extension) extension.loseContext();
    }
    gpu = null;
    labels = [];
    root.remove();
  }
}

const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const dimension = (value, fallback) => Math.max(0.5, finite(value, fallback));
const buildingHeight = item => dimension(item.height, 10);
const format = value => String(Math.round(value * 10) / 10);
const hex = (value, fallback) => /^#[\da-f]{6}$/i.test(value) ? value : fallback;

function rgb(value) {
  return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255);
}

function getBounds(scene) {
  let minX = 0, maxX = 100, minZ = 0, maxZ = 100, h = 12;
  for (const item of scene.locations) {
    const x = finite(item.x, 0), z = finite(item.z, 0);
    const w = dimension(item.width, 10), d = dimension(item.depth, 8);
    minX = Math.min(minX, x - w / 2 - 5); maxX = Math.max(maxX, x + w / 2 + 5);
    minZ = Math.min(minZ, z - d / 2 - 5); maxZ = Math.max(maxZ, z + d / 2 + 5);
    h = Math.max(h, buildingHeight(item) + 4);
  }
  for (const item of scene.characters) {
    const x = finite(item.x, 0), z = finite(item.z, 0);
    minX = Math.min(minX, x - 5); maxX = Math.max(maxX, x + 5);
    minZ = Math.min(minZ, z - 5); maxZ = Math.max(maxZ, z + 5);
  }
  return { minX, maxX, minZ, maxZ, w: maxX - minX, d: maxZ - minZ, h, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

// The waterfront sits just outside the scene's footprint in both views.
function landscape(b) {
  return [
    { x: b.cx, z: b.cz, w: b.w, d: b.d, y: -1, h: 1, color: '#dce3bf' },
    { x: b.cx, z: b.maxZ + 3, w: b.w, d: 7, y: -0.6, h: 0.25, color: '#8ec5cb' },
    { x: b.cx, z: b.maxZ - 2, w: b.w, d: 3, y: 0.005, h: 0.03, color: '#e4cfaa' },
    { x: b.cx, z: b.cz, w: 5, d: b.d - 4, y: 0.005, h: 0.02, color: '#efe4cf' },
    { x: b.cx, z: b.cz, w: b.w - 4, d: 5, y: 0.005, h: 0.02, color: '#efe4cf' },
  ];
}

function geometry(scene, bounds) {
  const vertices = [];
  function box(x, y, z, w, h, d, color) {
    const c = rgb(color);
    const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2, y1 = y + h;
    const faces = [
      [[0, 1, 0], [[x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0]]],
      [[0,-1, 0], [[x0,y,z0],[x1,y,z0],[x1,y,z1],[x0,y,z1]]],
      [[1, 0, 0], [[x1,y,z0],[x1,y1,z0],[x1,y1,z1],[x1,y,z1]]],
      [[-1,0, 0], [[x0,y,z1],[x0,y1,z1],[x0,y1,z0],[x0,y,z0]]],
      [[0, 0, 1], [[x1,y,z1],[x1,y1,z1],[x0,y1,z1],[x0,y,z1]]],
      [[0, 0,-1], [[x0,y,z0],[x0,y1,z0],[x1,y1,z0],[x1,y,z0]]],
    ];
    for (const [normal, corners] of faces) {
      for (const index of [0, 1, 2, 0, 2, 3]) vertices.push(...corners[index], ...normal, ...c);
    }
  }
  for (const item of landscape(bounds)) box(item.x, item.y, item.z, item.w, item.h, item.d, item.color);
  for (const item of scene.locations) {
    const x = finite(item.x, 0), z = finite(item.z, 0), h = buildingHeight(item);
    const w = dimension(item.width, 10), d = dimension(item.depth, 8);
    box(x, 0, z, w, h, d, hex(item.color, '#cf9b76'));
    box(x, h, z, w + 0.4, 0.55, d + 0.4, '#f2dfbb');
    // A door on the +Z side helps show the building's changing orientation.
    box(x, 0, z + d / 2 + 0.04, Math.min(2, w * 0.3), Math.min(4, h * 0.65), 0.12, '#665c4e');
  }
  for (const item of scene.characters) {
    const x = finite(item.x, 0), z = finite(item.z, 0), color = hex(item.color, '#547c76');
    box(x, 0, z, 3.2, 0.35, 3.2, '#fff9ea');
    box(x, 0.35, z, 2.3, 3.8, 2.3, color);
    box(x, 4.4, z, 2.7, 2.7, 2.7, color);
  }
  return new Float32Array(vertices);
}

function makeGPU(gl) {
  let vertex = null, fragment = null, program = null, buffer = null;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('无法创建着色器');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || '着色器编译失败');
    }
    return shader;
  };
  try {
    vertex = compile(gl.VERTEX_SHADER, `
      attribute vec3 a_position;
      attribute vec3 a_normal;
      attribute vec3 a_color;
      uniform mat4 u_matrix;
      varying mediump vec3 v_color;
      void main() {
        float light = 0.58 + 0.42 * max(dot(normalize(a_normal), normalize(vec3(-0.5, 1.0, 0.7))), 0.0);
        v_color = a_color * light;
        gl_Position = u_matrix * vec4(a_position, 1.0);
      }
    `);
    fragment = compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying mediump vec3 v_color;
      void main() { gl_FragColor = vec4(v_color, 1.0); }
    `);
    program = gl.createProgram();
    if (!program) throw new Error('无法创建 WebGL 程序');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || '着色器链接失败');
    buffer = gl.createBuffer();
    if (!buffer) throw new Error('无法创建顶点缓冲');
    return {
      program, buffer, count: 0,
      position: gl.getAttribLocation(program, 'a_position'),
      normal: gl.getAttribLocation(program, 'a_normal'),
      color: gl.getAttribLocation(program, 'a_color'),
      matrix: gl.getUniformLocation(program, 'u_matrix'),
    };
  } catch (error) {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

// Column-major matrices, compatible with WebGL uniforms.
function multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    }
  }
  return out;
}

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect,0,0,0, 0,f,0,0, 0,0,(far + near) * nf,-1, 0,0,2 * far * near * nf,0]);
}

function lookAt(eye, target) {
  const normalize = v => { const length = Math.hypot(...v) || 1; return v.map(n => n / length); };
  const z = normalize(eye.map((v, i) => v - target[i]));
  const x = normalize([z[2], 0, -z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const dot = v => v.reduce((sum, n, i) => sum + n * eye[i], 0);
  return new Float32Array([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -dot(x),-dot(y),-dot(z),1]);
}

function project(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w, w];
}
