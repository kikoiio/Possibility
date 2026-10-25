import type { EpochMs, Memory, Minutes } from '@wispiva/contract';

export type MemoryRow = Memory & {
  lineId: string;
  atMinutes: Minutes;
  lastAccessedMinutes?: Minutes;
};

export type ReflectionRow = {
  lineId: string;
  owner: string;
  version: number;
  text: string;
  fromMinutes: Minutes;
  toMinutes: Minutes;
  generatedAt: EpochMs;
};
