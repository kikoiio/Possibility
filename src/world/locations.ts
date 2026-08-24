// src/world/locations.ts — 世界地点清单（世界设定的一部分）
export const LOCATIONS = [
  '满月喫茶',
  '拾光旧书店',
  '海边堤坝',
  '神社台阶',
  '街心公园',
  '住家A',
  '住家B',
] as const;

export type Location = (typeof LOCATIONS)[number];

export function isLocation(value: string): value is Location {
  return (LOCATIONS as readonly string[]).includes(value);
}
