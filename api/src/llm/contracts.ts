/** Stable machine-readable failures shared by LLM transports and higher-level contracts. */
export type LlmErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'truncated'
  | 'malformed_stream'
  | 'invalid_json'
  | 'invalid_response'
  | 'contract_violation'
  | 'provider_http_error'
  | 'provider_error'

export const LLM_CONTRACT_VERSIONS = {
  schedule: 'schedule/v1',
  beat: 'beat/v2',
  dialogue: 'dialogue/v2',
  injection: 'injection/v2',
  summary: 'summary/v2',
  director: 'director/v1',
  sceneIntent: 'scene-intent/v1',
  sceneResponse: 'scene-response/v2',
  chapter: 'chapter/v1',
  voxelDistill: 'voxel-distill/v1',
} as const

export type LlmContractName = keyof typeof LLM_CONTRACT_VERSIONS

export class LlmContractError extends Error {
  constructor(readonly code: LlmErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LlmContractError'
  }
}

export function llmError(error: unknown, fallback: LlmErrorCode = 'provider_error'): LlmContractError {
  if (error instanceof LlmContractError) return error
  return new LlmContractError(fallback, error instanceof Error ? error.message : '模型调用失败', { cause: error })
}

export function contractViolation(contractVersion: string, message: string): never {
  throw new LlmContractError('contract_violation', `${contractVersion}: ${message}`)
}

/** Strict boundary: model contracts are one JSON object, never prose/code fences/arrays. */
export function parseContractObject(raw: string, contractVersion: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw.trim())
  } catch (error) {
    throw new LlmContractError('invalid_json', `${contractVersion}: 返回值不是纯 JSON`, { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return contractViolation(contractVersion, '顶层必须是 JSON 对象')
  }
  return value as Record<string, unknown>
}

export function requireString(
  value: unknown,
  field: string,
  contractVersion: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') return contractViolation(contractVersion, `${field} 必须是字符串`)
  const text = value.trim()
  if (!text || text.length > maxLength) {
    return contractViolation(contractVersion, `${field} 长度必须在 1-${maxLength}`)
  }
  return text
}

export function requireNumber(
  value: unknown,
  field: string,
  contractVersion: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return contractViolation(contractVersion, `${field} 必须是 ${min}-${max} 的有限数字`)
  }
  return value
}

export function requireBoolean(value: unknown, field: string, contractVersion: string): boolean {
  if (typeof value !== 'boolean') return contractViolation(contractVersion, `${field} 必须是布尔值`)
  return value
}
