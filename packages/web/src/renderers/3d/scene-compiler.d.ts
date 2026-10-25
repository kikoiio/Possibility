import type * as THREE from 'three';
import type { SceneDocument } from './scene-document.js';

export type CompileOptions = {
  materials: Record<string, THREE.Material>;
  details?: boolean;
  edited?: boolean;
  cutaway?: boolean;
  world?: THREE.Group & { userData: Record<string, any> };
};
export type CompiledScene = THREE.Group & { userData: Record<string, any> & { parts: Record<string, THREE.Group>; rebuiltParts: string[]; recipeHashes: Record<string, string> } };
export function compileScene(document: SceneDocument, backend: 'solid', options: CompileOptions): CompiledScene;
export function prepareSceneUpdate(document: SceneDocument, backend: 'solid', options: CompileOptions, requestedParts?: string[]): { rebuiltParts: string[]; commit(): CompiledScene; cancel(): void };
export function disposeWorld(world: CompiledScene): void;
export function partIdsFor(document: SceneDocument): string[];
export class SceneCompileError extends Error { diagnostics: Array<{ nodeId: string; operationId: string; requirementId: string; message: string }>; }
