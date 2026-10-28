import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadModelConfig({ root = repoRoot, envFile, env = process.env, readFile = readFileSync } = {}) {
  const path = resolve(root, envFile ?? env.WISPIVA_ENV_FILE ?? '.env');
  let fileEnv = {};
  try { fileEnv = parseEnv(readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取或解析环境配置文件。');
    if (envFile !== undefined || env.WISPIVA_ENV_FILE !== undefined) throw new Error('找不到指定的环境配置文件。');
  }
  // Parse into a separate object: .env must not modify Node's process options.
  const values = { ...fileEnv, ...env };
  const fields = {
    baseUrl: 'WISPIVA_LLM_BASE_URL',
    model: 'WISPIVA_LLM_MODEL',
    apiKey: 'WISPIVA_LLM_API_KEY',
  };
  const llm = {
    baseUrl: values[fields.baseUrl],
    model: values[fields.model],
    apiKey: values[fields.apiKey],
  };
  const problems = [];
  for (const key of ['baseUrl', 'model', 'apiKey']) {
    if (typeof llm[key] !== 'string' || !llm[key].trim()) {
      problems.push(`缺少 ${fields[key]}`);
    } else llm[key] = llm[key].trim();
  }
  if (typeof llm.baseUrl === 'string' && llm.baseUrl.trim()) {
    try {
      const url = new URL(llm.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      llm.baseUrl = url.href.replace(/\/+$/, '');
    } catch { problems.push('WISPIVA_LLM_BASE_URL 必须是 HTTP(S) API 基址，不含用户名、密码、查询参数或片段'); }
  }
  if (problems.length) throw new Error(`配置检查未通过：${problems.join('；')}。请填写 .env（参考 .env.example），或设置对应环境变量。`);
  return { envFile: path, llm };
}

export function configSummary(config) {
  return {
    protocol: 'responses',
    envFile: config.envFile,
    llm: {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      apiKeyConfigured: Boolean(config.llm.apiKey),
      streaming: true,
    },
  };
}
