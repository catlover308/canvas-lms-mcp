import { describe, expect, it } from 'vitest'
import { hasValidWorkerConfiguration } from '../src/worker'

const validEnv = {
  CANVAS_API_TOKEN: 'pasadena-token',
  CANVAS_COC_API_TOKEN: 'canyons-token',
  MCP_ACCESS_TOKEN: 'mcp-token',
  CANVAS_BASE_URL: 'https://canvas.pasadena.edu',
  CANVAS_COC_BASE_URL: 'https://coc.instructure.com',
} as Cloudflare.Env

describe('Worker health configuration', () => {
  it('accepts complete secrets and valid Canvas origins', () => {
    expect(hasValidWorkerConfiguration(validEnv)).toBe(true)
  })

  it('accepts a deliberately dormant Canyons integration', () => {
    expect(hasValidWorkerConfiguration({ ...validEnv, CANVAS_COC_API_TOKEN: '' })).toBe(true)
  })

  it.each([
    { ...validEnv, CANVAS_API_TOKEN: '' },
    { ...validEnv, MCP_ACCESS_TOKEN: '' },
    { ...validEnv, CANVAS_BASE_URL: 'not-a-url' },
    { ...validEnv, CANVAS_COC_BASE_URL: 'https://coc.instructure.com?token=bad' },
    { ...validEnv, CANVAS_BASE_URL: 'https://user:pass@canvas.pasadena.edu' },
  ])('rejects incomplete or unsafe configuration', (env) => {
    expect(hasValidWorkerConfiguration(env as Cloudflare.Env)).toBe(false)
  })
})
