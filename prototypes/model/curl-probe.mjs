import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelConfig } from './config.mjs';
import { buildResponsesEndpoint } from './model-client.mjs';

// One minimal request. Secrets go through stdin, never command arguments/files.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const marker = '\nWISPIVA_CURL_METRICS:';
function main() {
  const { llm } = loadModelConfig();
  if (/[\r\n]/.test(llm.apiKey)) throw new Error('Invalid credential format');
  const endpoint = buildResponsesEndpoint(llm.baseUrl);
  const body = { model: llm.model, input: 'Reply with exactly OK.', stream: false };
  const config = [
    `url = ${JSON.stringify(endpoint)}`,
    `header = ${JSON.stringify(`Authorization: Bearer ${llm.apiKey}`)}`,
    'header = "Content-Type: application/json"',
    `data = ${JSON.stringify(JSON.stringify(body))}`,
  ].join('\n') + '\n';
  const result = spawnSync('curl', [
    '-q', '--config', '-', '--silent', '--show-error', '--connect-timeout', '10',
    '--max-time', '120', '--retry', '0', '--max-filesize', '1048576',
    '--write-out', `${marker}%{json}`,
  ], { input: config, encoding: 'utf8', timeout: 125000, maxBuffer: 2 * 1024 * 1024 });
  const output = result.stdout ?? '';
  const split = output.lastIndexOf(marker);
  const raw = split < 0 ? output : output.slice(0, split);
  let metrics = {};
  try { metrics = JSON.parse(output.slice(split + marker.length)); } catch { /* Exit code still records failure. */ }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { /* Non-JSON failure body is retained after redaction. */ }
  const redact = (value) => {
    if (typeof value === 'string') return value.split(llm.apiKey).join('[REDACTED]').split(endpoint).join('[endpoint]');
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
    return value;
  };
  const report = redact({
    generatedAt: new Date().toISOString(), protocol: 'responses', transport: 'curl',
    curlExitCode: result.status, terminatedBySignal: result.signal, processErrorCode: result.error?.code ?? null,
    httpStatus: metrics.http_code ?? null,
    timingsSeconds: { dns: metrics.time_namelookup, connect: metrics.time_connect, tls: metrics.time_appconnect, firstByte: metrics.time_starttransfer, total: metrics.time_total },
    responseBytes: metrics.size_download ?? Buffer.byteLength(raw),
    stderr: result.stderr ?? '',
    response: parsed ?? raw,
  });
  mkdirSync(join(root, '.tmp/shared-model'), { recursive: true });
  writeFileSync(join(root, '.tmp/shared-model/curl-latest.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const texts = (Array.isArray(report.response?.output) ? report.response.output : [])
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((item) => item.type === 'output_text').map((item) => item.text).join('');
  console.log(JSON.stringify({ ...report, response: undefined,
    responseStatus: report.response?.status ?? null,
    outputText: texts || null, usage: report.response?.usage ?? null,
    providerError: report.response?.error ?? null,
    nonJsonBody: typeof report.response === 'string' ? report.response.slice(0, 2000) : undefined,
  }, null, 2));
  if (result.status !== 0 || !(report.httpStatus >= 200 && report.httpStatus < 300)) process.exitCode = 1;
}

try { main(); } catch {
  console.error('curl probe could not start or save its result; no configuration or credentials are displayed.');
  process.exitCode = 1;
}
