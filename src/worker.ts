import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { version } from '../package.json'
import { CanvasClient } from './canvas'
import { registerCanvasResources } from './resources/canvas'
import { registerInstitutionCanvasResources } from './resources/institutions'
import { isAuthorizedMcpRequest, stripMcpAuthorization, unauthorizedMcpResponse } from './mcp-auth'
import { applyMcpRequestCompatibility, applyMcpResponseCompatibility } from './mcp-compat'
import { registerMultiInstitutionTools } from './worker-tools'

type OptionalCanyonsSecret = Partial<Record<'CANVAS_COC_API_TOKEN', string>>

function readCanyonsToken(env: Cloudflare.Env): string | undefined {
  const token = (env as Cloudflare.Env & OptionalCanyonsSecret).CANVAS_COC_API_TOKEN
  return token?.trim() || undefined
}

function normalizeCanvasBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('CANVAS_BASE_URL must use http or https')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('CANVAS_BASE_URL must be an origin without credentials, query, or fragment')
  }
  return url.origin
}

export function hasValidWorkerConfiguration(env: Cloudflare.Env): boolean {
  if (!env.CANVAS_API_TOKEN || !env.MCP_ACCESS_TOKEN) {
    return false
  }
  try {
    normalizeCanvasBaseUrl(env.CANVAS_BASE_URL)
    normalizeCanvasBaseUrl(env.CANVAS_COC_BASE_URL)
    return true
  } catch {
    return false
  }
}

export function createCanvasWorkerServer(env: Cloudflare.Env): McpServer {
  if (!env.CANVAS_API_TOKEN) {
    throw new Error('CANVAS_API_TOKEN is not configured')
  }
  const pasadena = new CanvasClient({
    token: env.CANVAS_API_TOKEN,
    baseUrl: normalizeCanvasBaseUrl(env.CANVAS_BASE_URL),
  })
  const canyonsToken = readCanyonsToken(env)
  const canyons = canyonsToken
    ? new CanvasClient({
        token: canyonsToken,
        baseUrl: normalizeCanvasBaseUrl(env.CANVAS_COC_BASE_URL),
      })
    : undefined
  const server = new McpServer({ name: 'canvas-lms-mcp', version })

  registerMultiInstitutionTools(server, { pasadena, canyons })
  // Preserve the upstream Pasadena resource URIs and add explicit,
  // institution-qualified resources for both Canvas origins.
  registerCanvasResources(server, pasadena)
  registerInstitutionCanvasResources(server, { pasadena, canyons })
  return server
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      const configured = hasValidWorkerConfiguration(env)
      return Response.json(
        {
          ok: configured,
          service: 'canvas-lms-mcp',
          institutions: {
            pasadena: env.CANVAS_API_TOKEN ? 'configured' : 'unavailable',
            canyons: readCanyonsToken(env) ? 'configured' : 'dormant',
          },
        },
        { status: configured ? 200 : 503 },
      )
    }
    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 })
    }
    if (!(await isAuthorizedMcpRequest(request, env.MCP_ACCESS_TOKEN))) {
      return unauthorizedMcpResponse()
    }

    const handler = createMcpHandler(() => createCanvasWorkerServer(env), {
      route: '/mcp',
      legacy: 'stateless',
      onerror(error) {
        console.error(JSON.stringify({ event: 'mcp_error', message: error.message }))
      },
    })
    const compatible = applyMcpRequestCompatibility(stripMcpAuthorization(request))
    const response = await handler(compatible.request, env, ctx)
    return applyMcpResponseCompatibility(response, compatible.wantsJsonResponse)
  },
} satisfies ExportedHandler<Cloudflare.Env>
