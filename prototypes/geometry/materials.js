import * as THREE from 'three';

function texture(kind, base, accent, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  let seed = 741;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  if (kind === 'wood') {
    for (let i = 0; i < 85; i++) {
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.04 + random() * 0.12;
      ctx.lineWidth = 0.5 + random();
      const x = random() * size;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.bezierCurveTo(x + 5, 35, x - 4, 85, x + 2, size); ctx.stroke();
    }
  } else {
    for (let i = 0; i < 1200; i++) {
      ctx.fillStyle = accent;
      ctx.globalAlpha = random() * 0.11;
      const r = random() * 1.8;
      ctx.fillRect(random() * size, random() * size, r, r);
    }
    if (kind === 'stone') {
      ctx.globalAlpha = 0.13; ctx.strokeStyle = accent; ctx.lineWidth = 1;
      for (let y = 0; y < size; y += 24) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
        for (let x = (y / 24 % 2) * 18; x < size; x += 36) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 24); ctx.stroke(); }
      }
    }
  }
  ctx.globalAlpha = 1;
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  return map;
}

export function createMaterials() {
  const standard = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.83, ...extra });
  const textured = (kind, base, accent) => standard('#ffffff', { map: texture(kind, base, accent) });
  const palette = {
    grass: '#819a65', earth: '#766b50', stone: '#aaa58d', stoneDark: '#737b6c',
    plaster: '#e0d3ad', wood: '#71513b', woodLight: '#a37a4d', roof: '#46635c',
    roofLight: '#58766a', glass: '#b9e1da', water: '#5caaa4', waterLight: '#a6d2c0',
    leaf: '#5c7f50', leafLight: '#91a660', reed: '#afad6c', cream: '#eee0b9',
    terracotta: '#b96f4e', bookRed: '#8d4b3c', bookBlue: '#3f6c6a', bookGold: '#b5944e', dark: '#2f413a',
    street: '#3b3e40', paver: '#55504d', paverLight: '#77695c', brick: '#92574c', brickDark: '#4a3433',
    iron: '#273033', copper: '#b77746', marble: '#cfc3ad', woodDark: '#3d2d25', windowGlow: '#dca563', redSign: '#8f403b',
  };
  const result = {
    grass: textured('grain', '#819a65', '#354f39'),
    grassLight: standard('#9cab72'),
    earth: textured('stone', '#766b50', '#302e25'),
    stone: textured('stone', '#aaa58d', '#4f574d'),
    stoneDark: standard('#737b6c'),
    plaster: textured('grain', '#e0d3ad', '#87795d'),
    wood: textured('wood', '#71513b', '#231b16'),
    woodLight: textured('wood', '#a37a4d', '#4a3623'),
    roof: textured('grain', '#46635c', '#182f2c'),
    roofLight: standard('#58766a'),
    glass: standard('#b9e1da', { roughness: 0.18, metalness: 0.05, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false }),
    water: standard('#5caaa4', { roughness: 0.24, metalness: 0.18, transparent: true, opacity: 0.88 }),
    waterLight: standard('#a6d2c0', { roughness: 0.4, transparent: true, opacity: 0.55, depthWrite: false }),
    leaf: standard('#5c7f50', { side: THREE.DoubleSide }),
    leafLight: standard('#91a660', { side: THREE.DoubleSide }),
    reed: standard('#afad6c', { side: THREE.DoubleSide }),
    cream: standard('#eee0b9'),
    terracotta: standard('#b96f4e'),
    bookRed: standard('#8d4b3c'),
    bookBlue: standard('#3f6c6a'),
    bookGold: standard('#b5944e'),
    dark: standard('#2f413a'),
    street: textured('stone', '#3b3e40', '#171b1d'),
    paver: textured('stone', '#55504d', '#252321'),
    paverLight: textured('stone', '#77695c', '#322c28'),
    brick: textured('stone', '#92574c', '#3c2421'),
    brickDark: textured('stone', '#4a3433', '#211717'),
    iron: standard('#273033', { metalness: 0.68, roughness: 0.42 }),
    copper: standard('#b77746', { metalness: 0.62, roughness: 0.38 }),
    marble: textured('stone', '#cfc3ad', '#756c60'),
    woodDark: textured('wood', '#3d2d25', '#130d0a'),
    windowGlow: standard('#dca563', { roughness: 0.28, emissive: '#8b4b2c', emissiveIntensity: 0.28 }),
    redSign: textured('wood', '#8f403b', '#2b1414'),
  };
  for (const [name, material] of Object.entries(result)) material.userData.baseColor = palette[name];
  return result;
}

// The compiler and CPU checks use the same palette without allocating canvases.
export function createPlainMaterials() {
  const palette = {
    grass: '#7a9459', grassLight: '#9cb273', earth: '#6d6046', stone: '#a9a48e', stoneDark: '#6b7364',
    plaster: '#e4d7b4', wood: '#6b4a35', woodLight: '#a88053', roof: '#415c56', roofLight: '#5c7a6d',
    glass: '#bfe6dd', water: '#3f8f8c', waterLight: '#9fc9b8', leaf: '#4e7546', leafLight: '#8fa856',
    reed: '#a8a462', cream: '#f0e4c2', terracotta: '#b2664a', bookRed: '#8d4238', bookBlue: '#365f60',
    bookGold: '#b8934a', dark: '#283733', street: '#3b3e40', paver: '#55504d', paverLight: '#77695c',
    brick: '#92574c', brickDark: '#4a3433', iron: '#273033', copper: '#b77746', marble: '#cfc3ad',
    woodDark: '#3d2d25', windowGlow: '#dca563', redSign: '#8f403b',
  };
  const result = Object.fromEntries(Object.entries(palette).map(([name, color]) => {
    const translucent = ['glass', 'water', 'waterLight'].includes(name);
    const material = new THREE.MeshStandardMaterial({
      color, roughness: name === 'water' ? 0.22 : name === 'glass' ? 0.14 : 0.8, metalness: name === 'water' ? 0.3 : 0.02,
      flatShading: true, side: THREE.DoubleSide,
      transparent: translucent, opacity: name === 'glass' ? 0.4 : name === 'waterLight' ? 0.5 : 1,
      depthWrite: name !== 'glass' && name !== 'waterLight',
    });
    material.userData.baseColor = color;
    return [name, material];
  }));
  return result;
}
