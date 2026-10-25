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
  };
  for (const [name, material] of Object.entries(result)) material.userData.baseColor = palette[name];
  return result;
}
