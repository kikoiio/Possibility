import * as THREE from 'three';

export function createMaterials() {
  const standard = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.83, ...extra });
  const result = {
    grass: standard('#819a65'), grassLight: standard('#9cab72'), earth: standard('#766b50'),
    stone: standard('#aaa58d'), stoneDark: standard('#737b6c'), plaster: standard('#e0d3ad'),
    wood: standard('#71513b'), woodLight: standard('#a37a4d'), roof: standard('#46635c'),
    roofLight: standard('#58766a'), glass: standard('#b9e1da', { roughness: 0.18, metalness: 0.05, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false }),
    water: standard('#5caaa4', { roughness: 0.24, metalness: 0.18, transparent: true, opacity: 0.88 }),
    waterLight: standard('#a6d2c0', { roughness: 0.4, transparent: true, opacity: 0.55, depthWrite: false }),
    leaf: standard('#5c7f50', { side: THREE.DoubleSide }), leafLight: standard('#91a660', { side: THREE.DoubleSide }),
    reed: standard('#afad6c', { side: THREE.DoubleSide }), cream: standard('#eee0b9'), terracotta: standard('#b96f4e'),
    bookRed: standard('#8d4b3c'), bookBlue: standard('#3f6c6a'), bookGold: standard('#b5944e'), dark: standard('#2f413a'),
  };
  for (const [name, material] of Object.entries(result)) material.userData.baseColor = material.color;
  return result;
}
