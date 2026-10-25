import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createMaterials } from './materials.js';
import { solidCamera } from './solid.js';
import { voxelCamera } from './voxel.js';
import { compileScene, prepareSceneUpdate } from './scene-compiler.js';
import { libraryScene } from './scene-document.js';
import { getSettings, saveSettings, generateScene } from './model-client.js';
import { collectStats } from './primitives.js';
import './style.css';

const state = { mode: 'solid', view: 'island', edited: false, details: true, cutaway: false, scene: libraryScene };
const viewport = document.querySelector('#viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#c9dcd5');
scene.fog = new THREE.FogExp2('#c9dcd5', 0.012);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.setScissorTest(true);
viewport.appendChild(renderer.domElement);

const hemi = new THREE.HemisphereLight('#eff5df', '#617566', 2.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff1cf', 3.6);
sun.position.set(-14, 28, 17);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -27;
sun.shadow.camera.right = sun.shadow.camera.top = 27;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 80;
sun.shadow.bias = -0.00025;
sun.shadow.normalBias = 0.035;
scene.add(sun);
const fill = new THREE.DirectionalLight('#b7d4d3', 0.7);
fill.position.set(15, 10, -20);
scene.add(fill);

const materials = createMaterials();
const cameras = [makeCamera(), makeCamera()];
const controls = cameras.map(camera => {
  const control = new OrbitControls(camera, renderer.domElement);
  control.enableDamping = true;
  control.dampingFactor = 0.065;
  control.minDistance = 3;
  control.maxDistance = 75;
  control.maxPolarAngle = Math.PI * 0.485;
  return control;
});
let worlds = [];
let transition = null;
let lastTime = performance.now();
let frameAverage = 16.7;
let frameCount = 0;

function makeCamera() {
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
  camera.position.set(...solidCamera.island.position);
  return camera;
}

function rebuild() {
  if (!worlds.length) {
    worlds.push(...['solid', 'voxel'].map(backend => compileScene(state.scene, backend, { materials, ...state })));
    scene.add(...worlds);
  } else {
    updateDocument(state.scene);
  }
  updateMetrics();
}

function updateDocument(document) {
  // Prepare both dirty sets before committing either backend; rejected proposals preserve both views.
  const updates = [];
  try {
    worlds.forEach((world, i) => updates.push(prepareSceneUpdate(document, i === 0 ? 'solid' : 'voxel', { materials, ...state, world })));
  } catch (error) {
    updates.forEach(update => update.cancel());
    throw error;
  }
  updates.forEach(update => update.commit());
}

function applyDocument(document) {
  updateDocument(document);
  state.scene = document;
  updateMetrics();
}

function applyView(immediate = false) {
  const preset = (state.mode === 'voxel' ? voxelCamera : solidCamera)[state.view];
  controls.forEach((control, i) => {
    const camera = cameras[i];
    camera.fov = state.view === 'interior' ? 64 : 38;
    camera.updateProjectionMatrix();
    if (state.mode === 'split') {
      const factor = state.view === 'island' ? 1.25 : 1;
      camera.position.set(...preset.position.map(v => v * factor));
      control.target.set(...preset.target);
    } else {
      camera.position.set(...preset.position);
      control.target.set(...preset.target);
    }
    control.update();
  });
  transition = immediate ? null : { started: performance.now() };
}

function setMode(mode) {
  state.mode = mode;
  document.querySelector('.workspace').classList.toggle('split', mode === 'split');
  document.querySelectorAll('[data-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.mode === mode);
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  document.querySelector('#observation').textContent = {
    solid: '曲线、拱券和斜屋顶可以自由表达；部件仍保留独立身份。',
    voxel: '统一栅格组织了形体与材质；台阶、重复和细节决定最终观感。',
    split: '相同构图与尺度，对照轮廓、表面细节、空间和构造产物。',
  }[mode];
  applyView();
  updateMetrics();
}

function updateMetrics() {
  if (!worlds.length) return;
  const indexes = state.mode === 'split' ? [0, 1] : [state.mode === 'voxel' ? 1 : 0];
  const stats = indexes.map(i => collectStats(worlds[i]));
  document.querySelector('#metrics').innerHTML = `
    <div><dt>三角面${indexes.length > 1 ? '（几何 / 体素）' : ''}</dt><dd>${stats.map(s => s.triangles.toLocaleString()).join(' / ')}</dd></div>
    <div><dt>网格与实例批次</dt><dd>${stats.map(s => s.meshes).join(' / ')}</dd></div>
    <div><dt>帧时间（移动平均）</dt><dd id="frame-time">${frameAverage.toFixed(1)} ms</dd></div>`;
}

function renderWorld(index, x, width, height) {
  const camera = cameras[index];
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setViewport(x, 0, width, height);
  renderer.setScissor(x, 0, width, height);
  renderer.render(scene, camera);
}

function animateCharacter(now) {
  const t = now / 1000;
  for (const world of worlds) {
    for (const part of Object.values(world.userData.parts)) {
      const route = part.userData?.route;
      if (!Array.isArray(route) || route.length < 2) continue;
      if (!part.userData._walk) {
        const segs = [];
        let total = 0;
        for (let i = 0; i < route.length; i++) {
          const a = route[i], b = route[(i + 1) % route.length];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len > 1e-6) { segs.push({ a, b, len, start: total }); total += len; }
        }
        part.userData._walk = { segs, total };
      }
      const walk = part.userData._walk;
      if (!walk.total) continue;
      const d = (t * (part.userData.speed ?? 1.2)) % walk.total;
      const seg = walk.segs.find(s => d < s.start + s.len) ?? walk.segs[walk.segs.length - 1];
      const u = (d - seg.start) / seg.len;
      const [, homeY] = part.userData.home;
      part.position.x = seg.a[0] + (seg.b[0] - seg.a[0]) * u;
      part.position.z = seg.a[1] + (seg.b[1] - seg.a[1]) * u;
      part.position.y = homeY;
      part.rotation.y = Math.atan2(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
    }
  }
}

function animate(now) {
  const dt = now - lastTime;
  lastTime = now;
  frameAverage = frameAverage * 0.96 + dt * 0.04;
  animateCharacter(now);
  controls.forEach(control => control.update());
  const width = viewport.clientWidth, height = viewport.clientHeight;
  if (renderer.domElement.width !== Math.round(width * renderer.getPixelRatio()) || renderer.domElement.height !== Math.round(height * renderer.getPixelRatio())) renderer.setSize(width, height, false);
  worlds.forEach((world, i) => { world.visible = state.mode === 'split' || (state.mode === 'solid' ? i === 0 : i === 1); });
  if (state.mode === 'split') {
    const left = Math.floor(width / 2);
    worlds[0].visible = true; worlds[1].visible = false;
    renderWorld(0, 0, left, height);
    worlds[0].visible = false; worlds[1].visible = true;
    renderWorld(1, left, width - left, height);
  } else renderWorld(state.mode === 'voxel' ? 1 : 0, 0, width, height);
  if (++frameCount % 45 === 0) {
    const node = document.querySelector('#frame-time');
    if (node) node.textContent = `${frameAverage.toFixed(1)} ms`;
  }
  requestAnimationFrame(animate);
}

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  state.view = button.dataset.view;
  if (state.view === 'interior') {
    state.cutaway = false;
    document.querySelector('#cutaway-toggle').checked = false;
    rebuild();
  }
  document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('selected', item === button));
  document.querySelector('.workspace').classList.toggle('interior', state.view === 'interior');
  applyView();
}));
document.querySelector('#reset-view').addEventListener('click', () => applyView());
document.querySelector('#details-toggle').addEventListener('change', event => { state.details = event.target.checked; rebuild(); });
document.querySelector('#cutaway-toggle').addEventListener('change', event => { state.cutaway = event.target.checked; rebuild(); });
document.querySelector('#edit-porch').addEventListener('click', () => {
  state.edited = !state.edited;
  rebuild();
  document.querySelector('#edit-porch span:nth-child(2)').textContent = state.edited ? '恢复临水门廊' : '换成观景台';
  document.querySelector('#edit-status').textContent = state.edited ? '仅 porch / bridge 重建 · 版本 B' : '已恢复 · 基准版本 A';
});

// 支持用 ?doc=/generated/... 加载任意 SceneDocument（如生成的村庄），否则展示默认藏书屋。
const urlDoc = new URLSearchParams(location.search).get('doc');
(urlDoc
  ? fetch(urlDoc).then(response => {
      if (!response.ok) throw new Error(`${response.status} ${urlDoc}`);
      return response.json();
    }).then(doc => { state.scene = doc; })
  : Promise.resolve()
).then(() => {
  rebuild();
  applyView(true);
  requestAnimationFrame(animate);
  requestAnimationFrame(() => document.querySelector('#loading').classList.add('done'));
}).catch(error => {
  console.error(error);
  requestAnimationFrame(() => {
    const loading = document.querySelector('#loading');
    if (loading) loading.textContent = `场景加载失败：${error.message}`;
  });
});
window.__geometryLab = { state, renderer, worlds, collectStats, setMode, applyView, rebuild, applyDocument };

const modelDialog = document.querySelector('#model-dialog');
const settingsStatus = document.querySelector('#model-settings-status');
const creationStatus = document.querySelector('#creation-status');
document.querySelector('#creation-toggle').addEventListener('click', () => document.querySelector('#creation-panel').classList.toggle('open'));
document.querySelector('#model-settings-button').addEventListener('click', async () => {
  modelDialog.showModal();
  settingsStatus.textContent = '正在读取本机设置…';
  try {
    const settings = await getSettings();
    document.querySelector('#model-base-url').value = settings.baseUrl;
    document.querySelector('#model-name').value = settings.model;
    document.querySelector('#model-api-key').value = '';
    document.querySelector('#model-api-key').placeholder = settings.keyConfigured ? '已配置；留空保持不变' : '仅保存到本机 .data';
    settingsStatus.textContent = `今日已调用 ${settings.callsToday} 次`;
    creationStatus.textContent = settings.keyConfigured && settings.model ? '真实模型模式 · 生成会消耗你的模型额度' : '固定配方模式 · 请先在模型设置中配置模型';
  } catch (error) { settingsStatus.textContent = error.message; }
});
document.querySelector('#save-model-settings').addEventListener('click', async () => {
  settingsStatus.textContent = '正在保存…';
  try {
    await saveSettings({ baseUrl: document.querySelector('#model-base-url').value, model: document.querySelector('#model-name').value, apiKey: document.querySelector('#model-api-key').value });
    settingsStatus.textContent = '已保存到本机；未发起生成调用';
  } catch (error) { settingsStatus.textContent = error.message; }
});
document.querySelector('#creation-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector('#create-button');
  button.disabled = true;
  creationStatus.textContent = '模型正在生成语义文档，当前世界保持不变…';
  try {
    const result = await generateScene(document.querySelector('#creation-input').value, state.scene);
    applyDocument(result.document);
    creationStatus.textContent = `已生成 ${result.document.title} · 场景文档校验通过`;
  } catch (error) { creationStatus.textContent = `未修改当前世界：${error.message}`; }
  finally { button.disabled = false; }
});
