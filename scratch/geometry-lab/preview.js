// 预览页：?doc=/generated/glm-session/<id>.generate.json
// 同一 SceneDocument 双后端并排渲染，仅用于肉眼检查生成结果，不含任何模型调用。
import * as THREE from 'three';
import { createMaterials } from './src/materials.js';
import { solidCamera } from './src/solid.js';
import { compileScene } from './src/scene-compiler.js';

const params = new URLSearchParams(location.search);
const docUrl = params.get('doc') || '/generated/glm-session/v1-quayside.generate.json';

const docEl = document;
const viewport = docEl.querySelector('#viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#c9dcd5');
scene.fog = new THREE.FogExp2('#c9dcd5', 0.0035);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.setScissorTest(true);
viewport.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight('#eff5df', '#617566', 2.1));
const sun = new THREE.DirectionalLight('#fff1cf', 3.4);
sun.position.set(-18, 30, 17);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 90 });
sun.shadow.bias = -0.00025;
sun.shadow.normalBias = 0.035;
scene.add(sun);
const fill = new THREE.DirectionalLight('#b7d4d3', 0.7);
fill.position.set(15, 10, -20);
scene.add(fill);

const materials = createMaterials();
const cameras = [0, 1].map(() => {
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  camera.position.set(...solidCamera.island.position);
  camera.lookAt(...solidCamera.island.target);
  return camera;
});

const sceneDoc = await fetch(docUrl).then(response => {
  if (!response.ok) throw new Error(`${response.status} ${docUrl}`);
  return response.json();
});
docEl.querySelector('#title').textContent = sceneDoc.title;

const worlds = ['solid', 'voxel'].map((backend, i) => {
  const world = compileScene(sceneDoc, backend, { materials, details: true, edited: false, cutaway: false });
  world.visible = true;
  scene.add(world);
  // 相机对准场景包围盒，村庄比单栋藏书屋更宽。
  // 水域平面(2000×2000)会撑爆包围盒;取景只按村庄实际尺度,钳制半径。
  const box = new THREE.Box3().setFromObject(world);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.min(Math.max(box.getSize(new THREE.Vector3()).length() / 2, 18), 34);
  cameras[i].position.set(center.x + radius * 1.15, center.y + radius * 0.95, center.z + radius * 1.35);
  cameras[i].lookAt(center);
  return world;
});

function render() {
  const width = viewport.clientWidth, height = viewport.clientHeight;
  if (renderer.domElement.width !== Math.round(width * renderer.getPixelRatio())) renderer.setSize(width, height, false);
  const left = Math.floor(width / 2);
  for (const [index, x, w] of [[0, 0, left], [1, left, width - left]]) {
    const camera = cameras[index];
    camera.aspect = w / height;
    camera.updateProjectionMatrix();
    renderer.setViewport(x, 0, w, height);
    renderer.setScissor(x, 0, w, height);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(render);
}
render();

window.__preview = {
  ready: true,
  title: sceneDoc.title,
  docId: sceneDoc.id,
  stats: worlds.map(world => world.userData.rebuiltParts.length),
  renderer,
  cameras,
  scene,
};
