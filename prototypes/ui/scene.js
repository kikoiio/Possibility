import { createWorldScene } from './world-scene.js';

function makeShell(host) {
  const root = document.createElement('div');
  Object.assign(root.style, { position: 'absolute', inset: '0', overflow: 'hidden', isolation: 'isolate' });
  const stage = document.createElement('div');
  Object.assign(stage.style, { position: 'absolute', inset: '0' });
  // No caption element: weather, totals and the drag hint are drawn inside the
  // scene itself (chips and legend), so a separate overlay can no longer
  // collide with them on a narrow screen.
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'scene-reset';
  reset.textContent = '重置视角';
  reset.setAttribute('aria-label', '重置世界视角');
  Object.assign(reset.style, { position: 'absolute', right: '24px', top: '24px', zIndex: '4' });
  root.append(stage, reset);
  host.replaceChildren(root);
  return { root, stage, reset };
}

export async function createScene(host, state) {
  if (state?.world?.profile !== 'generated-world') throw new Error('场景需要生成世界状态');
  return createWorldScene(makeShell(host), state);
}
