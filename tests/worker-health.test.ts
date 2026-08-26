import { describe, expect, it } from 'vitest'
import worker, { hasValidWorkerConfiguration } from '../src/worker'
import {
  WORKER_CONTRACT_VERSION,
  WORKER_SOURCE_REPOSITORY,
  WORKER_TOOL_NAMES,
} from '../src/worker-tools'

const validEnv = {
  CANVAS_API_TOKEN: 'pasadena-token',
  MCP_ACCESS_TOKEN: 'mcp-token',
  OWNER_SECRET: 'owner-secret-that-is-at-least-32-characters',
  CANVAS_BASE_URL: 'https://canvas.pasadena.edu',
} as Cloudflare.Env

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as ExecutionContext

describe('Worker health configuration', () => {
  it('accepts complete secrets and valid Canvas origins', () => {
    expect(hasValidWorkerConfiguration(validEnv)).toBe(true)
  })

  it.each([
    { ...validEnv, CANVAS_API_TOKEN: '' },
    { ...validEnv, MCP_ACCESS_TOKEN: '' },
    { ...validEnv, OWNER_SECRET: 'too-short' },
    { ...validEnv, CANVAS_BASE_URL: 'not-a-url' },
    { ...validEnv, CANVAS_BASE_URL: 'https://user:pass@canvas.pasadena.edu' },
  ])('rejects incomplete or unsafe configuration', (env) => {
    expect(hasValidWorkerConfiguration(env as Cloudflare.Env)).toBe(false)
  })

  it('publishes an exact provenance marker on /health', async () => {
    const response = await worker.fetch(
      new Request('https://canvas-mcp-cf.brycel.net/health'),
      validEnv,
      executionContext,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      service: 'canvas-lms-mcp',
      contract: WORKER_CONTRACT_VERSION,
      tools: [...WORKER_TOOL_NAMES],
      source: WORKER_SOURCE_REPOSITORY,
      oauth: 'configured',
      institution: 'pasadena',
    })
  })

  it('rejects unauthenticated MCP requests', async () => {
    const response = await worker.fetch(
      new Request('https://canvas-mcp-cf.brycel.net/mcp', { method: 'POST' }),
      validEnv,
      executionContext,
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  it('advertises exactly the public six-tool read-only contract over MCP', async () => {
    const response = await worker.fetch(
      new Request('https://canvas-mcp-cf.brycel.net/mcp', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${validEnv.MCP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      validEnv,
      executionContext,
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      result: { tools: Array<{ name: string; annotations?: Record<string, boolean> }> }
    }
    expect(payload.result.tools.map((tool) => tool.name)).toEqual([...WORKER_TOOL_NAMES])
    expect(
      payload.result.tools.every(
        (tool) =>
          tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false,
      ),
    ).toBe(true)
  })
})
