import { describe, expect, it } from 'vitest'
import { isVerificationValid, verificationFingerprint } from './connection-test'

const config = { baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'sk-canary' }
describe('personal verification fingerprint', () => {
  it('normalizes endpoint/model, binds user and every credential field', async () => {
    const fingerprint = await verificationFingerprint('u', config)
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(await verificationFingerprint('u', { ...config, baseUrl: ' https://provider.example/v1/// ', model: ' m ' })).toBe(fingerprint)
    for (const [user, fields] of [['other', config], ['u', { ...config, apiKey: 'changed' }],
      ['u', { ...config, model: 'other' }], ['u', { ...config, baseUrl: 'https://other.example' }]] as const) {
      expect(await verificationFingerprint(user, fields)).not.toBe(fingerprint)
    }
    expect(await isVerificationValid('u', { ...config, verificationFingerprint: fingerprint, verifiedAt: '2026-10-03' })).toBe(true)
    expect(await isVerificationValid('other', { ...config, verificationFingerprint: fingerprint, verifiedAt: '2026-10-03' })).toBe(false)
  })
  it('incomplete configurations and whitespace-only credentials cannot be verified', async () => {
    for (const fields of [{ ...config, baseUrl: null }, { ...config, model: '' }, { ...config, apiKey: ' ' }]) {
      expect(await verificationFingerprint('u', fields)).toBeNull()
    }
    expect(await isVerificationValid('u', { ...config, verificationFingerprint: 'wrong', verifiedAt: '2026-10-03' })).toBe(false)
  })
})
