import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { version } from '../package.json'
import { CanvasClient } from './canvas'
import { isAuthorizedMcpRequest, stripMcpAuthorization, unauthorizedMcpResponse } from './mcp-auth'
import { applyMcpRequestCompatibility, applyMcpResponseCompatibility } from './mcp-compat'
import { handleOAuthRequest } from './mcp-oauth'
import {
  registerCanvasCloudTools,
  WORKER_CONTRACT_VERSION,
  WORKER_SOURCE_REPOSITORY,
  WORKER_TOOL_NAMES,
} from './worker-tools'

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
  if (
    !env.CANVAS_API_TOKEN ||
    !env.MCP_ACCESS_TOKEN ||
    !env.OWNER_SECRET ||
    env.OWNER_SECRET.length < 32
  ) {
    return false
  }
  try {
    normalizeCanvasBaseUrl(env.CANVAS_BASE_URL)
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
  const server = new McpServer({ name: 'canvas-lms-mcp', version })
  registerCanvasCloudTools(server, pasadena)
  return server
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const oauthResponse = await handleOAuthRequest(request, env)
    if (oauthResponse) return oauthResponse
    if (url.pathname === '/health') {
      const configured = hasValidWorkerConfiguration(env)
      return Response.json(
        {
          ok: configured,
          service: 'canvas-lms-mcp',
          contract: WORKER_CONTRACT_VERSION,
          tools: [...WORKER_TOOL_NAMES],
          source: WORKER_SOURCE_REPOSITORY,
          oauth: env.OWNER_SECRET?.length >= 32 ? 'configured' : 'unavailable',
          institution: env.CANVAS_API_TOKEN ? 'pasadena' : 'unavailable',
        },
        { status: configured ? 200 : 503 },
      )
    }
    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 })
    }
    if (!(await isAuthorizedMcpRequest(request, env.MCP_ACCESS_TOKEN, env.OWNER_SECRET))) {
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
