import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { version } from '../package.json'
import { CanvasClient } from './canvas'
import { registerCanvasResources } from './resources/canvas'
import { registerMultiInstitutionTools } from './worker-tools'

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

function createCanvasWorkerServer(env: Cloudflare.Env): McpServer {
  if (!env.CANVAS_API_TOKEN) {
    throw new Error('CANVAS_API_TOKEN is not configured')
  }
  if (!env.CANVAS_COC_API_TOKEN) {
    throw new Error('CANVAS_COC_API_TOKEN is not configured')
  }

  const pasadena = new CanvasClient({
    token: env.CANVAS_API_TOKEN,
    baseUrl: normalizeCanvasBaseUrl(env.CANVAS_BASE_URL),
  })
  const canyons = new CanvasClient({
    token: env.CANVAS_COC_API_TOKEN,
    baseUrl: normalizeCanvasBaseUrl(env.CANVAS_COC_BASE_URL),
  })
  const server = new McpServer({ name: 'canvas-lms-mcp', version })

  registerMultiInstitutionTools(server, { pasadena, canyons })
  registerCanvasResources(server, pasadena)
  return server
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        service: 'canvas-lms-mcp',
        institutions: ['pasadena', 'canyons'],
      })
    }
    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 })
    }

    const handler = createMcpHandler(() => createCanvasWorkerServer(env), {
      route: '/mcp',
      legacy: 'stateless',
      onerror(error) {
        console.error(JSON.stringify({ event: 'mcp_error', message: error.message }))
      },
    })
    return handler(request, env, ctx)
  },
} satisfies ExportedHandler<Cloudflare.Env>
