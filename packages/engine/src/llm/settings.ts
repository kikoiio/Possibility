import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { LlmSettings } from './client.js';

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  models: ['llama-3.3-70b-versatile'],
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  segmentWorldMinutes: 60,
  minIntervalSeconds: 60,
  hourlyLimit: 40,
  dailyLimit: 200,
  concurrency: 2,
};

export type SettingsStore = {
  settings: LlmSettings;
  writeSettings: (settings: LlmSettings) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSettings(value: unknown, defaults: LlmSettings): LlmSettings {
  if (!isRecord(value)) throw new Error('LLM settings must be a JSON object.');
  const models = parseModels(value.models ?? defaults.models);
  const baseUrl = value.baseUrl ?? defaults.baseUrl;
  const apiKey = value.apiKey ?? defaults.apiKey;
  const segmentWorldMinutes = parseNonnegativeNumber(value.segmentWorldMinutes, defaults.segmentWorldMinutes, 'segmentWorldMinutes');
  const minIntervalSeconds = parseNonnegativeNumber(value.minIntervalSeconds, defaults.minIntervalSeconds, 'minIntervalSeconds');
  const hourlyLimit = parseNonnegativeNumber(value.hourlyLimit, defaults.hourlyLimit, 'hourlyLimit');
  const dailyLimit = parseNonnegativeNumber(value.dailyLimit, defaults.dailyLimit, 'dailyLimit');
  const concurrency = parseNonnegativeNumber(value.concurrency, defaults.concurrency, 'concurrency');
  if (typeof baseUrl !== 'string' || !baseUrl.trim() || typeof apiKey !== 'string') {
    throw new Error('LLM settings baseUrl and apiKey must be strings.');
  }
  if (concurrency < 1) throw new Error('LLM settings concurrency must be at least 1.');
  return {
    models: [...models], baseUrl, apiKey,
    segmentWorldMinutes, minIntervalSeconds, hourlyLimit, dailyLimit, concurrency,
  };
}

function parseModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('LLM settings models must be a non-empty array of model names.');
  }
  return value.map((model: unknown) => {
    if (typeof model !== 'string' || !model.trim()) {
      throw new Error('LLM settings models must be a non-empty array of model names.');
    }
    return model;
  });
}

function parseNonnegativeNumber(value: unknown, fallback: number, key: string): number {
  const number = value ?? fallback;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid LLM setting: ${key}.`);
  }
  return number;
}

async function readDocument(path: string): Promise<Record<string, unknown> | null> {
  try {
    const contents = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed)) throw new Error('LLM settings file must contain a JSON object.');
    return parsed;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function openSettingsStore(options: {
  path?: string;
  defaults?: LlmSettings;
} = {}): Promise<SettingsStore> {
  const path = resolve(options.path ?? '.data/wispiva/config.json');
  const defaults = options.defaults ?? DEFAULT_LLM_SETTINGS;
  const stored = await readDocument(path);
  const settings = parseSettings(stored ?? defaults, defaults);
  // 环境变量回退:未在配置文件写 apiKey 时,读 GROQ_LLM_API_KEY(本地 .env 即可,不入库)。
  if (!settings.apiKey && process.env.GROQ_LLM_API_KEY) {
    settings.apiKey = process.env.GROQ_LLM_API_KEY;
  }

  const writeSettings = async (next: LlmSettings): Promise<void> => {
    const validated = parseSettings(next, defaults);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    Object.assign(settings, validated, { models: [...validated.models] });
  };

  if (stored) await chmod(path, 0o600);
  return { settings, writeSettings };
}
