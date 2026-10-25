export type ModelProbeFailureCode = 'unauthorized' | 'not_found' | 'rate_limited' | 'unavailable' | 'http_error' | 'network_error';

export type ModelProbeResult = {
  available: string[];
  failures: Array<{ model: string; code: ModelProbeFailureCode; status?: number; message?: string }>;
};

export async function probeModels(options: {
  models: string[];
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): Promise<ModelProbeResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const available: string[] = [];
  const failures: ModelProbeResult['failures'] = [];
  const url = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`;

  for (const model of options.models) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with one character.' }],
          max_tokens: 1,
          temperature: 0,
        }),
      });
      if (response.ok) {
        available.push(model);
        continue;
      }
      const code: ModelProbeFailureCode = response.status === 401 ? 'unauthorized'
        : response.status === 404 ? 'not_found'
          : response.status === 429 ? 'rate_limited'
            : response.status === 503 ? 'unavailable' : 'http_error';
      failures.push({ model, code, status: response.status });
    } catch (error) {
      failures.push({ model, code: 'network_error', message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { available, failures };
}
