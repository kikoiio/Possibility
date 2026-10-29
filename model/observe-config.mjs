import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadModelConfig, configSummary } from './config.mjs';

// Only the public example is read from disk. Every loader read is injected.
const example = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
const fixture = 'WISPIVA_LLM_BASE_URL=https://fixture.invalid/v1/\nWISPIVA_LLM_MODEL=fixture-model\nWISPIVA_LLM_API_KEY="synthetic-secret"\n';
const missing = () => { throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' }); };
const load = (text = fixture, options = {}) => loadModelConfig({ root: '/synthetic-wispiva', env: {}, readFile: () => text, ...options });
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

check('one env file suffices; JSON is never requested', () => {
  const paths = [];
  const config = load(fixture, { readFile: (path) => { paths.push(path); return fixture; } });
  assert.deepEqual(paths, ['/synthetic-wispiva/.env']);
  assert.equal(config.llm.apiKey, 'synthetic-secret');
  assert.equal(config.llm.baseUrl, 'https://fixture.invalid/v1');
  assert.deepEqual(config.llm, { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model', apiKey: 'synthetic-secret' });
  assert.equal(Object.hasOwn(config.llm, 'timeoutMs'), false);
  assert.equal(Object.hasOwn(config.llm, 'maxOutputTokens'), false);
});
check('shell variables override all file settings', () => {
  const config = load(fixture, { env: {
    WISPIVA_LLM_BASE_URL: 'https://override.invalid/responses', WISPIVA_LLM_MODEL: 'override-model',
    WISPIVA_LLM_API_KEY: 'override-secret',
  } });
  assert.deepEqual(config.llm, { baseUrl: 'https://override.invalid/responses', model: 'override-model', apiKey: 'override-secret' });
});
check('reasoning is opt-in, validated and can be overridden without changing model or limits', () => {
  assert.equal(load(fixture + 'WISPIVA_LLM_REASONING_EFFORT=low\n').llm.reasoningEffort, 'low');
  assert.equal(load(fixture + 'WISPIVA_LLM_REASONING_EFFORT=low\n', { env: { WISPIVA_LLM_REASONING_EFFORT: 'high' } }).llm.reasoningEffort, 'high');
  assert.throws(() => load(fixture + 'WISPIVA_LLM_REASONING_EFFORT=guess\n'), /WISPIVA_LLM_REASONING_EFFORT/);
});
check('environment-only deployment needs no local file', () => {
  assert.equal(load('', { readFile: missing, env: {
    WISPIVA_LLM_BASE_URL: 'https://fixture.invalid/v1', WISPIVA_LLM_MODEL: 'fixture-model', WISPIVA_LLM_API_KEY: 'synthetic-secret',
  } }).llm.model, 'fixture-model');
});
check('explicit env file wins over environment path', () => {
  assert.equal(load(fixture, { envFile: '/synthetic/selected.env', env: { WISPIVA_ENV_FILE: '/synthetic/ignored.env' } }).envFile, '/synthetic/selected.env');
});
check('environment can select a relative env file', () => {
  assert.equal(load(fixture, { env: { WISPIVA_ENV_FILE: 'selected.env' } }).envFile, '/synthetic-wispiva/selected.env');
});
check('missing explicitly selected file is reported', () => {
  assert.throws(() => load('', { envFile: 'missing.env', readFile: missing }), /找不到指定的环境配置文件/);
});
check('missing fields identify environment variable names', () => {
  assert.throws(() => load('', { readFile: missing }), (error) => ['WISPIVA_LLM_BASE_URL', 'WISPIVA_LLM_MODEL', 'WISPIVA_LLM_API_KEY'].every((name) => error.message.includes(name)));
});
check('required values cannot be blank', () => {
  assert.throws(() => load(fixture + 'WISPIVA_LLM_API_KEY="   "\n'), /缺少 WISPIVA_LLM_API_KEY/);
});
check('legacy file limits are ignored, including invalid values', () => {
  const baseline = load().llm;
  for (const value of ['30000', '2048', '120000', '8192', '', '0', '-1', '1.5', 'Infinity', '1e3', '0x10', '9007199254740992']) {
    assert.deepEqual(load(fixture + `WISPIVA_LLM_TIMEOUT_MS=${value}\nWISPIVA_LLM_MAX_OUTPUT_TOKENS=${value}\n`).llm, baseline);
  }
});
check('legacy environment limits are ignored even when overriding file values', () => {
  const baseline = load().llm;
  for (const value of ['30000', '2048', '120000', '8192', '', '0', '-1', '1.5', 'Infinity', '1e3', '0x10', '9007199254740992']) {
    assert.deepEqual(load(fixture + 'WISPIVA_LLM_TIMEOUT_MS=120000\nWISPIVA_LLM_MAX_OUTPUT_TOKENS=8192\n', {
      env: { WISPIVA_LLM_TIMEOUT_MS: value, WISPIVA_LLM_MAX_OUTPUT_TOKENS: value },
    }).llm, baseline);
  }
});
check('invalid and credential-bearing URLs are rejected without echoing values', () => {
  for (const url of ['bad-url', 'file:///synthetic', 'https://user:synthetic-secret@fixture.invalid/v1', 'https://fixture.invalid/v1?key=synthetic-secret', 'https://fixture.invalid/v1#synthetic-secret']) {
    assert.throws(() => load(fixture + `WISPIVA_LLM_BASE_URL="${url}"\n`), (error) => error.message.includes('WISPIVA_LLM_BASE_URL 必须') && !error.message.includes('synthetic-secret'));
  }
});
check('summary confirms presence without exposing key', () => {
  const summary = configSummary(load());
  assert.equal(summary.protocol, 'responses');
  assert.equal(summary.llm.apiKeyConfigured, true);
  assert.equal(summary.llm.streaming, true);
  assert.equal(Object.hasOwn(summary.llm, 'timeoutMs'), false);
  assert.equal(Object.hasOwn(summary.llm, 'maxOutputTokens'), false);
  assert.equal(JSON.stringify(summary).includes('synthetic-secret'), false);
});
check('summary does not expose legacy budgets supplied by a caller', () => {
  const config = load();
  assert.deepEqual(configSummary({ ...config, llm: { ...config.llm, timeoutMs: 30000, maxOutputTokens: 2048 } }), configSummary(config));
});
check('required values are trimmed using only injected file and environment values', () => {
  assert.deepEqual(load('WISPIVA_LLM_BASE_URL=" https://fixture.invalid/v1/ "\nWISPIVA_LLM_MODEL=" fixture-model "\nWISPIVA_LLM_API_KEY=" ignored-file-key "\n', {
    env: { WISPIVA_LLM_API_KEY: ' synthetic-secret ' },
  }).llm, load().llm);
});
check('file cannot mutate process environment', () => {
  const before = { ...process.env };
  load(fixture + 'NODE_OPTIONS=--invalid-synthetic-option\n');
  assert.deepEqual({ ...process.env }, before);
});
check('reader errors do not expose file contents', () => {
  assert.throws(() => load('', { readFile: () => { throw new Error('synthetic-secret'); } }), (error) => error.message === '无法读取或解析环境配置文件。');
});
check('public example is provider neutral and works after filling required fields', () => {
  assert.equal(example.includes('xf-yun'), false);
  assert.equal(example.includes('spark-x2.6'), false);
  assert.equal(example.includes('WISPIVA_LLM_TIMEOUT_MS'), false);
  assert.equal(example.includes('WISPIVA_LLM_MAX_OUTPUT_TOKENS'), false);
  assert.throws(() => load(example), /缺少 WISPIVA_LLM_BASE_URL/);
  assert.equal(load(example + '\n' + fixture).llm.apiKey, 'synthetic-secret');
});
console.log(`${passed}/${passed} configuration checks passed. No private files or network requests.`);
