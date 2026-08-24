import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { DEFAULT_CONFIG, getConfig, inSleepWindow } from '../src/config';

beforeEach(async () => {
  await env.CONFIG_KV.delete('config');
});

describe('getConfig', () => {
  it('KV 无值时返回默认值', async () => {
    const config = await getConfig(env);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.timezone).toBe('Asia/Shanghai');
    expect(config.modelTiers.cheap.model).toBe('deepseek-chat');
  });

  it('KV 只覆盖部分字段，其余回落默认', async () => {
    await env.CONFIG_KV.put('config', JSON.stringify({ activationRate: 0.9 }));
    const config = await getConfig(env);
    expect(config.activationRate).toBe(0.9);
    expect(config.timezone).toBe('Asia/Shanghai');
  });

  it('KV 嵌套字段部分覆盖', async () => {
    await env.CONFIG_KV.put('config', JSON.stringify({ sleepWindow: { start: '23:30' } }));
    const config = await getConfig(env);
    expect(config.sleepWindow.start).toBe('23:30');
    expect(config.sleepWindow.end).toBe('07:00');
  });

  it('非法 JSON 回落默认值', async () => {
    await env.CONFIG_KV.put('config', '{broken');
    expect(await getConfig(env)).toEqual(DEFAULT_CONFIG);
  });

  it('类型错误回落默认值', async () => {
    await env.CONFIG_KV.put('config', JSON.stringify({ activationRate: 'high' }));
    expect(await getConfig(env)).toEqual(DEFAULT_CONFIG);
  });
});

describe('inSleepWindow', () => {
  const config = DEFAULT_CONFIG; // 默认 01:00 - 07:00

  it('窗口内/外的判断', () => {
    expect(inSleepWindow(config, '03:00')).toBe(true);
    expect(inSleepWindow(config, '01:00')).toBe(true);
    expect(inSleepWindow(config, '07:00')).toBe(false);
    expect(inSleepWindow(config, '12:00')).toBe(false);
  });

  it('跨零点窗口', () => {
    const night = {
      ...config,
      sleepWindow: { start: '23:00', end: '07:00' },
    };
    expect(inSleepWindow(night, '23:30')).toBe(true);
    expect(inSleepWindow(night, '02:00')).toBe(true);
    expect(inSleepWindow(night, '12:00')).toBe(false);
  });
});
