import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { compileScene, disposeWorld, prepareSceneUpdate } from './scene-compiler.js';
import { createMaterials } from './materials.js';
import type { SceneDocument } from './scene-document.js';

export type SceneViewProps = { scene: SceneDocument; animate?: boolean; className?: string };

export function SceneView({ scene, animate = true, className }: SceneViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<{ renderer: THREE.WebGLRenderer; world: ReturnType<typeof compileScene>; materials: ReturnType<typeof createMaterials>; frame: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(canvas.clientWidth || 640, canvas.clientHeight || 480, false);
    const scene3d = new THREE.Scene();
    scene3d.background = new THREE.Color('#dce8dc');
    scene3d.add(new THREE.HemisphereLight('#fff7df', '#52644f', 2.1));
    const sunlight = new THREE.DirectionalLight('#fff1d3', 2.5);
    sunlight.position.set(20, 35, 16);
    scene3d.add(sunlight);
    const camera = new THREE.PerspectiveCamera(42, (canvas.clientWidth || 640) / (canvas.clientHeight || 480), 0.1, 1200);
    camera.position.set(27, 22, 31);
    camera.lookAt(0, 2, 0);
    const materials = createMaterials();
    const world = compileScene(scene, 'solid', { materials, details: true, edited: false, cutaway: false });
    scene3d.add(world);
    let active = true;
    const draw = () => {
      if (!active) return;
      renderer.render(scene3d, camera);
      if (animate) runtimeRef.current!.frame = requestAnimationFrame(draw);
    };
    runtimeRef.current = { renderer, world, materials, frame: 0 };
    draw();
    const resize = () => {
      const width = canvas.clientWidth || 640, height = canvas.clientHeight || 480;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.render(scene3d, camera);
    };
    window.addEventListener('resize', resize);
    return () => {
      active = false;
      cancelAnimationFrame(runtimeRef.current?.frame ?? 0);
      window.removeEventListener('resize', resize);
      disposeWorld(world);
      for (const material of Object.values(materials)) material.dispose();
      renderer.dispose();
      runtimeRef.current = null;
    };
  }, [animate]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const update = prepareSceneUpdate(scene, 'solid', { materials: runtime.materials, details: true, edited: false, cutaway: false, world: runtime.world });
    runtime.world = update.commit();
  }, [scene]);

  return <canvas ref={canvasRef} className={className} aria-label="3D scene" />;
}
