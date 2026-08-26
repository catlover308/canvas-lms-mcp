import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleOAuthRequest, MCP_RESOURCE, verifyOAuthAccessToken } from '../src/mcp-oauth'

const OWNER_SECRET = 'owner-secret-that-is-at-least-32-characters'
const env = { OWNER_SECRET } as Cloudflare.Env
const redirectUri = 'https://claude.ai/api/mcp/auth_callback'
const verifier = 'a'.repeat(64)
const challenge = createHash('sha256').update(verifier).digest('base64url')

async function register(): Promise<string> {
  const response = await handleOAuthRequest(
    new Request('https://canvas-mcp-cf.brycel.net/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
      }),
    }),
    env,
  )
  expect(response?.status).toBe(201)
  return ((await response?.json()) as { client_id: string }).client_id
}

async function authorize(clientId: string): Promise<{ code: string }> {
  const url = new URL('https://canvas-mcp-cf.brycel.net/oauth/authorize')
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: MCP_RESOURCE,
    scope: 'canvas.mcp offline_access',
    state: 'fixed-state',
  }).toString()
  const page = await handleOAuthRequest(new Request(url), env)
  expect(page?.status).toBe(200)
  const html = await page!.text()
  expect(html).toContain('six read-only student tools')
  expect(html).toContain('No Canvas write tools are available')
  expect(html).not.toContain('all 165 Canvas tools')
  expect(html).toContain('data-bwignore="true"')
  expect(html).toContain('formmethod="post"')
  expect(page!.headers.get('content-security-policy')).toContain(
    'form-action https://canvas-mcp-cf.brycel.net https://canvas-mcp.brycel.net',
  )
  const consentToken = html.match(/name="consent_token" value="([^"]+)"/)?.[1]
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
  expect(consentToken).toBeTruthy()
  expect(csrf).toBeTruthy()

  const approval = await handleOAuthRequest(
    new Request('https://canvas-mcp-cf.brycel.net/oauth/authorize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://canvas-mcp-cf.brycel.net',
      },
      body: new URLSearchParams({
        consent_token: consentToken!,
        csrf: csrf!,
        owner_secret: OWNER_SECRET,
      }),
    }),
    env,
  )
  expect(approval?.status).toBe(302)
  const callback = new URL(approval!.headers.get('location')!)
  expect(callback.origin + callback.pathname).toBe(redirectUri)
  expect(callback.searchParams.get('state')).toBe('fixed-state')
  expect(callback.searchParams.get('iss')).toBe('https://canvas-mcp-cf.brycel.net')
  expect(callback.toString().length).toBeLessThan(512)
  return { code: callback.searchParams.get('code')! }
}

describe('stateless OAuth server', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fetches ChatGPT CIMD metadata without following redirects', async () => {
    const clientId = 'https://chatgpt.com/oauth/test-client/client.json'
    const redirectUri = 'https://chatgpt.com/connector/oauth/test-client'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        client_id: clientId,
        client_name: 'ChatGPT',
        redirect_uris: [redirectUri],
      }),
    )
    const url = new URL('https://canvas-mcp-cf.brycel.net/authorize')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: MCP_RESOURCE,
      scope: 'canvas.mcp',
    }).toString()

    const response = await handleOAuthRequest(new Request(url), env)

    expect(response?.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(clientId),
      expect.objectContaining({ redirect: 'manual' }),
    )
  })

  it('accepts ChatGPT opaque client IDs with connector redirect URIs', async () => {
    const clientId = '0c5e4754-2ef5-4ff0-8f0a-9bc82d06f6ec'
    const redirectUri = 'https://chatgpt.com/connector/oauth/AFjf7ta-WJRc'
    const url = new URL('https://canvas-mcp-cf.brycel.net/authorize')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://canvas-mcp.brycel.net/mcp',
      scope: 'canvas.mcp',
    }).toString()

    const response = await handleOAuthRequest(new Request(url), env)

    expect(response?.status).toBe(200)
    expect(await response?.text()).toContain('ChatGPT')
  })

  it('canonicalizes the legacy resource alias during token exchange', async () => {
    const clientId = '0c5e4754-2ef5-4ff0-8f0a-9bc82d06f6ec'
    const redirectUri = 'https://chatgpt.com/connector/oauth/AFjf7ta-WJRc'
    const url = new URL('https://canvas-mcp-cf.brycel.net/authorize')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://canvas-mcp.brycel.net/mcp',
      scope: 'canvas.mcp',
      state: 'legacy-resource-state',
    }).toString()
    const page = await handleOAuthRequest(new Request(url), env)
    expect(page?.status).toBe(200)
    const html = await page!.text()
    const consentToken = html.match(/name="consent_token" value="([^"]+)"/)?.[1]
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
    const approval = await handleOAuthRequest(
      new Request('https://canvas-mcp-cf.brycel.net/oauth/authorize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://canvas-mcp-cf.brycel.net',
        },
        body: new URLSearchParams({
          consent_token: consentToken!,
          csrf: csrf!,
          owner_secret: OWNER_SECRET,
        }),
      }),
      env,
    )
    expect(approval?.status).toBe(302)
    const callback = new URL(approval!.headers.get('location')!)
    const token = await handleOAuthRequest(
      new Request('https://canvas-mcp-cf.brycel.net/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code: callback.searchParams.get('code')!,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource: 'https://canvas-mcp.brycel.net/mcp',
        }),
      }),
      env,
    )
    const issued = (await token?.json()) as { access_token: string }

    expect(token?.status).toBe(200)
    expect(await verifyOAuthAccessToken(issued.access_token, OWNER_SECRET)).toBe(true)
  })

  it('rejects a tampered CSRF value without relying on browser headers or cookies', async () => {
    const clientId = await register()
    const url = new URL('https://canvas-mcp-cf.brycel.net/oauth/authorize')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: MCP_RESOURCE,
      scope: 'canvas.mcp',
    }).toString()
    const page = await handleOAuthRequest(new Request(url), env)
    const html = await page!.text()
    const consentToken = html.match(/name="consent_token" value="([^"]+)"/)?.[1]
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
    const rejected = await handleOAuthRequest(
      new Request('https://canvas-mcp-cf.brycel.net/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          consent_token: consentToken!,
          csrf: `${csrf!}tampered`,
          owner_secret: OWNER_SECRET,
        }),
      }),
      env,
    )
    expect(rejected?.status).toBe(400)
    expect(await rejected?.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'Authorization session is invalid or expired.',
    })
  })

  it.each(['https://canvas-mcp-cf.brycel.net', 'https://canvas-mcp.brycel.net', 'null'])(
    'accepts the signed consent form from supported origin %s',
    async (origin) => {
      const clientId = await register()
      const url = new URL('https://canvas-mcp-cf.brycel.net/oauth/authorize')
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: MCP_RESOURCE,
        scope: 'canvas.mcp',
      }).toString()
      const page = await handleOAuthRequest(new Request(url), env)
      const html = await page!.text()
      const consentToken = html.match(/name="consent_token" value="([^"]+)"/)?.[1]
      const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]

      const approval = await handleOAuthRequest(
        new Request('https://canvas-mcp-cf.brycel.net/oauth/authorize', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: origin,
          },
          body: new URLSearchParams({
            consent_token: consentToken!,
            csrf: csrf!,
            owner_secret: OWNER_SECRET,
          }),
        }),
        env,
      )
      expect(approval?.status).toBe(302)
    },
  )

  it('rejects a third-party authorization form origin', async () => {
    const clientId = await register()
    const url = new URL('https://canvas-mcp-cf.brycel.net/oauth/authorize')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: MCP_RESOURCE,
      scope: 'canvas.mcp',
    }).toString()
    const page = await handleOAuthRequest(new Request(url), env)
    const html = await page!.text()
    const consentToken = html.match(/name="consent_token" value="([^"]+)"/)?.[1]
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]

    const rejected = await handleOAuthRequest(
      new Request('https://canvas-mcp-cf.brycel.net/oauth/authorize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://attacker.example',
        },
        body: new URLSearchParams({
          consent_token: consentToken!,
          csrf: csrf!,
          owner_secret: OWNER_SECRET,
        }),
      }),
      env,
    )
    expect(rejected?.status).toBe(400)
    expect(await rejected?.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'Authorization request origin is invalid.',
    })
  })

  it('publishes OAuth 2.1 discovery metadata', async () => {
    const resource = await handleOAuthRequest(
      new Request('https://canvas-mcp-cf.brycel.net/.well-known/oauth-protected-resource/mcp'),
      env,
    )
    expect(resource?.status).toBe(200)
    expect(await resource?.json()).toMatchObject({
      resource: MCP_RESOURCE,
      authorization_servers: ['https://canvas-mcp-cf.brycel.net'],
    })

    const server = await handleOAuthRequest(
      new Request('https://canvas-mcp-cf.brycel.net/.well-known/oauth-authorization-server'),
      env,
    )
    expect(await server?.json()).toMatchObject({
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    })
  })

  it('completes DCR, owner approval, PKCE exchange, and refresh', async () => {
    const clientId = await register()
    const { code } = await authorize(clientId)
    const token = await handleOAuthRequest(
      new Request('https://canvas-mcp-cf.brycel.net/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource: MCP_RESOURCE,
        }),
      }),
      env,
    )
    expect(token?.status).toBe(200)
    const issued = (await token?.json()) as { access_token: string; refresh_token: string }
    expect(await verifyOAuthAccessToken(issued.access_token, OWNER_SECRET)).toBe(true)
    expect(await verifyOAuthAccessToken(`${issued.access_token}x`, OWNER_SECRET)).toBe(false)

    const refreshed = await handleOAuthRequest(
      new Request('https://canvas-mcp-cf.brycel.net/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: issued.refresh_token,
          resource: MCP_RESOURCE,
        }),
      }),
      env,
    )
    expect(refreshed?.status).toBe(200)
  })

  it('rejects wrong owner secrets and unregistered redirects', async () => {
    const clientId = await register()
    const url = new URL('https://canvas-mcp-cf.brycel.net/oauth/authorize')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://attacker.example/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: MCP_RESOURCE,
    }).toString()
    const response = await handleOAuthRequest(new Request(url), env)
    expect(response?.status).toBe(400)
    expect(await response?.json()).toMatchObject({ error: 'invalid_request' })
  })
})
