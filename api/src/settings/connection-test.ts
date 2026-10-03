export interface VerifiableLlmConfig {
  baseUrl: string | null
  model: string | null
  apiKey: string | null
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export async function verificationFingerprint(userId: string, config: VerifiableLlmConfig): Promise<string | null> {
  if (!config.baseUrl?.trim() || !config.model?.trim() || !config.apiKey?.trim()) return null
  const input = JSON.stringify([
    userId,
    normalizeBaseUrl(config.baseUrl),
    config.model.trim(),
    config.apiKey,
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function isVerificationValid(
  userId: string,
  config: VerifiableLlmConfig & { verificationFingerprint?: string | null; verifiedAt?: string | null },
): Promise<boolean> {
  const fingerprint = await verificationFingerprint(userId, config)
  return Boolean(fingerprint && config.verificationFingerprint && config.verifiedAt
    && fingerprint === config.verificationFingerprint)
}
