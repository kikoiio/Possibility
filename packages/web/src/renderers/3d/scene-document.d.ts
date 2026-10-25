export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type SceneRegion =
  | { id: string; kind: 'water'; center: Vec2; size: Vec2; elevation: number }
  | { id: string; kind: 'island'; center: Vec2; radius: number; elevation: number; irregularity: number };
export type SceneObject = {
  id: string; kind: 'library' | 'porch' | 'bridge' | 'house' | 'path' | 'tree' | 'character'; name: string;
  [key: string]: unknown;
};
export type SceneDocument = { schemaVersion: 1; id: string; title: string; style: { palette: string; voxelUnit: number; seed: number }; regions: SceneRegion[]; objects: SceneObject[] };
export function validateSceneDocument(document: unknown): Array<{ nodeId: string; operationId: string; requirementId: string; message: string }>;
export function validateSpatialLayout(document: SceneDocument): Array<{ nodeId: string; operationId: string; requirementId: string; message: string }>;
export const libraryScene: SceneDocument;
export const villageScene: SceneDocument;
