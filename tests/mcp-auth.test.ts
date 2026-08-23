import { describe, expect, it } from 'vitest'
import {
  isAuthorizedMcpRequest,
  stripMcpAuthorization,
  unauthorizedMcpResponse,
} from '../src/mcp-auth'

describe('remote MCP authentication', () => {
  it('accepts a matching bearer credential', async () => {
    const request = new Request('https://example.com/mcp', {
      headers: { Authorization: 'Bearer correct-token' },
    })
    expect(await isAuthorizedMcpRequest(request, 'correct-token')).toBe(true)
  })

  it.each([
    new Request('https://example.com/mcp'),
    new Request('https://example.com/mcp?key=wrong-token'),
    new Request('https://example.com/mcp', { headers: { Authorization: 'Basic abc' } }),
  ])('rejects missing or invalid credentials', async (request) => {
    expect(await isAuthorizedMcpRequest(request, 'correct-token')).toBe(false)
  })

  it('fails closed when the Worker access secret is absent', async () => {
    const request = new Request('https://example.com/mcp', {
      headers: { Authorization: 'Bearer anything' },
    })
    expect(await isAuthorizedMcpRequest(request, '')).toBe(false)
  })

  it('strips authorization before MCP handling', async () => {
    const request = new Request('https://example.com/mcp', {
      headers: { Authorization: 'Bearer correct-token', Accept: 'application/json' },
    })
    const stripped = stripMcpAuthorization(request)
    expect(stripped.headers.has('authorization')).toBe(false)
    expect(stripped.headers.get('accept')).toBe('application/json')
  })

  it('returns a non-cacheable bearer challenge without exposing a secret', async () => {
    const response = unauthorizedMcpResponse()
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
    expect(await response.text()).not.toContain('correct-token')
  })
})
