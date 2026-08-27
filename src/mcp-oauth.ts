const CANONICAL_ORIGIN = 'https://canvas-mcp-cf.brycel.net'
const LEGACY_ORIGIN = 'https://canvas-mcp.brycel.net'
export const MCP_RESOURCE = `${CANONICAL_ORIGIN}/mcp`
export const OAUTH_SCOPE = 'canvas.mcp'
const OPTIONAL_OFFLINE_SCOPE = 'offline_access'
const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp'
const MAX_BODY_BYTES = 32 * 1024
const MAX_CLIENT_ID_BYTES = 16 * 1024
const CODE_TTL_SECONDS = 5 * 60
const ACCESS_TTL_SECONDS = 60 * 60
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60
const CONSENT_TTL_SECONDS = 10 * 60

type TokenKind = 'client' | 'consent' | 'code' | 'access' | 'refresh'

interface BaseTokenPayload {
  typ: TokenKind
  iat: number
  exp?: number
  nonce: string
}

interface RegisteredClientPayload extends BaseTokenPayload {
  typ: 'client'
  clientName: string
  redirectUris: string[]
}

interface ConsentPayload extends BaseTokenPayload {
  typ: 'consent'
  clientId: string
  clientName: string
  redirectUri: string
  codeChallenge: string
  resource: string
  scope: string
  state?: string
  csrf: string
}

interface AuthorizationCodePayload extends BaseTokenPayload {
  typ: 'code'
  b: string
  p: string
  s: 0 | 1
}

interface AccessTokenPayload extends BaseTokenPayload {
  typ: 'access'
  clientId: string
  aud: string
  scope: string
  sub: 'canvas-owner'
}

interface RefreshTokenPayload extends BaseTokenPayload {
  typ: 'refresh'
  clientId: string
  resource: string
  scope: string
  sub: 'canvas-owner'
}

interface ResolvedClient {
  clientId: string
  clientName: string
  redirectUris: string[]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function randomToken(bytes = 24): string {
  const value = new Uint8Array(bytes)
  crypto.getRandomValues(value)
  return base64UrlEncode(value)
}

function base64UrlEncode(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const padded =
      value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)
    const binary = atob(padded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

async function hmacKey(secret: string, usage: Array<'sign' | 'verify'>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  )
}

async function signToken<T extends BaseTokenPayload>(
  kind: T['typ'],
  payload: Omit<T, 'typ' | 'iat' | 'nonce'> & Partial<Pick<T, 'iat' | 'nonce'>>,
  secret: string,
): Promise<string> {
  const complete = {
    ...payload,
    typ: kind,
    iat: payload.iat ?? nowSeconds(),
    nonce: payload.nonce ?? randomToken(),
  } as T
  const body = base64UrlEncode(JSON.stringify(complete))
  const unsigned = `cmcp_${kind}.${body}`
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), encoder.encode(unsigned)),
  )
  return `${unsigned}.${base64UrlEncode(signature)}`
}

async function verifyToken<T extends BaseTokenPayload>(
  token: string,
  kind: T['typ'],
  secret: string,
): Promise<T | null> {
  if (secret.length < 32 || token.length > MAX_CLIENT_ID_BYTES) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== `cmcp_${kind}`) return null
  const body = parts[1]
  const signature = base64UrlDecode(parts[2] ?? '')
  const payloadBytes = base64UrlDecode(body ?? '')
  if (!body || !signature || !payloadBytes || signature.byteLength !== 32) return null
  const verified = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret, ['verify']),
    signature,
    encoder.encode(`${parts[0]}.${body}`),
  )
  if (!verified) return null
  try {
    const parsed = JSON.parse(decoder.decode(payloadBytes)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (record.typ !== kind || typeof record.iat !== 'number' || typeof record.nonce !== 'string') {
      return null
    }
    if (typeof record.exp === 'number' && record.exp <= nowSeconds()) return null
    return parsed as T
  } catch {
    return null
  }
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ])
  const leftBytes = new Uint8Array(leftDigest)
  const rightBytes = new Uint8Array(rightDigest)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!
  }
  return difference === 0
}

async function authorizationCodeBinding(
  clientId: string,
  redirectUri: string,
  resource: string,
  scope: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(`${clientId}\0${redirectUri}\0${resource}\0${scope}`),
    ),
  )
  return base64UrlEncode(digest)
}

async function readBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > maxBytes) {
    return null
  }
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

function hasContentType(request: Request, expected: string): boolean {
  return request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === expected
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readBody(request)
  if (body === null || body.trim() === '') return null
  try {
    const value = JSON.parse(body) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const body = await readBody(request)
  return body === null ? null : new URLSearchParams(body)
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status)
}

function methodNotAllowed(allow: string): Response {
  return new Response('Method not allowed', { status: 405, headers: { Allow: allow } })
}

function isValidRedirectUri(value: string): boolean {
  if (value.length === 0 || value.length > 2_048) return false
  try {
    const url = new URL(value)
    const loopback =
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    return (url.protocol === 'https:' || loopback) && !url.hash && !url.username && !url.password
  } catch {
    return false
  }
}

function canonicalResource(value: string): string | null {
  if (value === MCP_RESOURCE || value === `${LEGACY_ORIGIN}/mcp`) return MCP_RESOURCE
  return null
}

function normalizeScope(value: string | null): string | null {
  const scopes = [...new Set((value?.trim() || OAUTH_SCOPE).split(/\s+/).filter(Boolean))]
  if (!scopes.includes(OAUTH_SCOPE)) return null
  if (scopes.some((scope) => scope !== OAUTH_SCOPE && scope !== OPTIONAL_OFFLINE_SCOPE)) {
    return null
  }
  return scopes.join(' ')
}

function validateRedirectUris(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) return null
  if (!value.every((uri) => typeof uri === 'string' && isValidRedirectUri(uri))) return null
  const unique = [...new Set(value as string[])]
  return JSON.stringify(unique).length <= 12 * 1024 ? unique : null
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function consentPage(
  consentToken: string,
  csrf: string,
  client: ResolvedClient,
  redirectUri: string,
): Response {
  // Chromium applies form-action to the POST's redirect as well as its action URL.
  // authorizeGet has already validated this exact callback against the client registration.
  const redirectUrl = new URL(redirectUri)
  const redirectHost = redirectUrl.host
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Canvas MCP</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#171717}.card{border:1px solid #d4d4d4;border-radius:.75rem;padding:2rem}label{display:block;margin:1.25rem 0 .4rem}input{box-sizing:border-box;width:100%;padding:.7rem;border:1px solid #a3a3a3;border-radius:.4rem}button{margin-top:1.25rem;padding:.7rem 1rem;border:0;border-radius:.4rem;background:#171717;color:white;font-weight:600}.muted{color:#525252;font-size:.9rem}code{overflow-wrap:anywhere}
</style></head><body><main class="card"><h1>Authorize Canvas MCP</h1>
<p><strong>${escapeHtml(client.clientName)}</strong> is requesting access to the Canvas MCP server.</p>
<p class="muted">Callback: <code>${escapeHtml(redirectHost)}</code>. This server exposes six read-only student tools for the configured Pasadena Canvas account. No Canvas write tools are available.</p>
<form method="post" action="${CANONICAL_ORIGIN}/oauth/authorize"><input type="hidden" name="consent_token" value="${escapeHtml(consentToken)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label for="owner_secret">Owner secret</label>
<input id="owner_secret" name="owner_secret" type="password" autocomplete="off" data-bwignore="true" data-1p-ignore required autofocus>
<button type="submit" formmethod="post" formaction="${CANONICAL_ORIGIN}/oauth/authorize">Authorize client</button></form></main></body></html>`
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${CANONICAL_ORIGIN} ${LEGACY_ORIGIN} ${redirectUrl.origin}; frame-ancestors 'none'; base-uri 'none'`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  })
}

async function readBoundedJsonResponse(
  response: Response,
): Promise<Record<string, unknown> | null> {
  if (!response.ok || !response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > 64 * 1024) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let body: string
  try {
    body = decoder.decode(bytes)
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(body) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

async function resolveCimdClient(clientId: string): Promise<ResolvedClient | null> {
  if (clientId.length > 2_048) return null
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'chatgpt.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/client.json')
  ) {
    return null
  }
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    // Workers only implements follow/manual. Manual preserves the same
    // fail-closed behavior because readBoundedJsonResponse rejects 3xx.
    redirect: 'manual',
  })
  const metadata = await readBoundedJsonResponse(response)
  if (!metadata || metadata.client_id !== clientId) return null
  const redirectUris = validateRedirectUris(metadata.redirect_uris)
  if (!redirectUris) return null
  const clientName = typeof metadata.client_name === 'string' ? metadata.client_name : 'ChatGPT'
  if (clientName.length === 0 || clientName.length > 200) return null
  return { clientId, clientName, redirectUris }
}

function isChatGptConnectorRedirectUri(value: string): boolean {
  if (!isValidRedirectUri(value)) return false
  const url = new URL(value)
  return url.origin === 'https://chatgpt.com' && url.pathname.startsWith('/connector/oauth/')
}

function resolveChatGptOpaqueClient(clientId: string, redirectUri: string): ResolvedClient | null {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)
  ) {
    return null
  }
  if (!isChatGptConnectorRedirectUri(redirectUri)) return null
  return { clientId, clientName: 'ChatGPT', redirectUris: [redirectUri] }
}

async function resolveClient(
  clientId: string,
  secret: string,
  redirectUri: string,
): Promise<ResolvedClient | null> {
  if (clientId.startsWith('https://')) return resolveCimdClient(clientId)
  const payload = await verifyToken<RegisteredClientPayload>(clientId, 'client', secret)
  if (!payload) return resolveChatGptOpaqueClient(clientId, redirectUri)
  if (payload.clientName.length > 200) return null
  const redirectUris = validateRedirectUris(payload.redirectUris)
  if (!redirectUris) return null
  return { clientId, clientName: payload.clientName, redirectUris }
}

export function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer: CANONICAL_ORIGIN,
    authorization_endpoint: `${CANONICAL_ORIGIN}/oauth/authorize`,
    token_endpoint: `${CANONICAL_ORIGIN}/oauth/token`,
    registration_endpoint: `${CANONICAL_ORIGIN}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [OAUTH_SCOPE, OPTIONAL_OFFLINE_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}

export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [CANONICAL_ORIGIN],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Canvas LMS MCP',
  }
}

async function registerClient(request: Request, secret: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  if (!hasContentType(request, 'application/json')) {
    return oauthError('invalid_request', 'Content-Type must be application/json.', 415)
  }
  const body = await readJson(request)
  const redirectUris = validateRedirectUris(body?.redirect_uris)
  if (!redirectUris) {
    return oauthError(
      'invalid_client_metadata',
      'redirect_uris must contain one to ten HTTPS or loopback URLs.',
    )
  }
  if (
    body?.token_endpoint_auth_method !== undefined &&
    body.token_endpoint_auth_method !== 'none'
  ) {
    return oauthError(
      'invalid_client_metadata',
      'Only public clients using token_endpoint_auth_method none are supported.',
    )
  }
  const requestedName = typeof body?.client_name === 'string' ? body.client_name.trim() : ''
  if (requestedName.length > 200) {
    return oauthError('invalid_client_metadata', 'client_name must not exceed 200 characters.')
  }
  const clientName = requestedName || 'MCP client'
  const clientId = await signToken<RegisteredClientPayload>(
    'client',
    { clientName, redirectUris },
    secret,
  )
  return json(
    {
      client_id: clientId,
      client_id_issued_at: nowSeconds(),
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    201,
  )
}

async function authorizeGet(request: Request, secret: string): Promise<Response> {
  const params = new URL(request.url).searchParams
  const clientId = params.get('client_id') ?? ''
  const redirectUri = params.get('redirect_uri') ?? ''
  const state = params.get('state')
  const client = await resolveClient(clientId, secret, redirectUri)
  if (!client) return oauthError('invalid_request', 'Unknown OAuth client.')
  if (!client.redirectUris.includes(redirectUri)) {
    return oauthError('invalid_request', 'Unregistered redirect URI.')
  }
  if (params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256') {
    return oauthError('invalid_request', 'Authorization code with S256 PKCE is required.')
  }
  const challenge = params.get('code_challenge') ?? ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return oauthError('invalid_request', 'A valid S256 code challenge is required.')
  }
  const resource = canonicalResource(params.get('resource') ?? MCP_RESOURCE)
  if (!resource) return oauthError('invalid_target', 'The resource must be this MCP server.')
  const scope = normalizeScope(params.get('scope'))
  if (!scope) return oauthError('invalid_scope', 'Unsupported OAuth scope.')
  if (state !== null && state.length > 2_048)
    return oauthError('invalid_request', 'State is too long.')
  const csrf = randomToken()
  const consentToken = await signToken<ConsentPayload>(
    'consent',
    {
      clientId,
      clientName: client.clientName,
      redirectUri,
      codeChallenge: challenge,
      resource,
      scope,
      ...(state ? { state } : {}),
      csrf,
      exp: nowSeconds() + CONSENT_TTL_SECONDS,
    },
    secret,
  )
  return consentPage(consentToken, csrf, client, redirectUri)
}

async function authorizePost(request: Request, secret: string): Promise<Response> {
  if (!hasContentType(request, 'application/x-www-form-urlencoded')) {
    return oauthError(
      'invalid_request',
      'Content-Type must be application/x-www-form-urlencoded.',
      415,
    )
  }
  const form = await readForm(request)
  if (!form) return oauthError('invalid_request', 'Malformed or oversized authorization form.')
  const consentToken = form.get('consent_token') ?? ''
  const consent = await verifyToken<ConsentPayload>(consentToken, 'consent', secret)
  if (!consent) return oauthError('invalid_request', 'Authorization request is invalid or expired.')
  const csrf = form.get('csrf') ?? ''
  if (!csrf || !(await constantTimeEqual(csrf, consent.csrf))) {
    return oauthError('invalid_request', 'Authorization session is invalid or expired.')
  }
  const origin = request.headers.get('origin')
  if (origin && origin !== CANONICAL_ORIGIN && origin !== LEGACY_ORIGIN && origin !== 'null') {
    return oauthError('invalid_request', 'Authorization request origin is invalid.')
  }
  if (!(await constantTimeEqual(form.get('owner_secret') ?? '', secret))) {
    return new Response('Authorization denied', {
      status: 403,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    })
  }
  const code = await signToken<AuthorizationCodePayload>(
    'code',
    {
      b: await authorizationCodeBinding(
        consent.clientId,
        consent.redirectUri,
        consent.resource,
        consent.scope,
      ),
      p: consent.codeChallenge,
      s: consent.scope.split(/\s+/).includes(OPTIONAL_OFFLINE_SCOPE) ? 1 : 0,
      exp: nowSeconds() + CODE_TTL_SECONDS,
    },
    secret,
  )
  const redirect = new URL(consent.redirectUri)
  redirect.searchParams.set('code', code)
  if (consent.state) redirect.searchParams.set('state', consent.state)
  redirect.searchParams.set('iss', CANONICAL_ORIGIN)
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      'Cache-Control': 'no-store',
    },
  })
}

async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return false
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))
  return constantTimeEqual(base64UrlEncode(digest), challenge)
}

async function issueTokens(
  clientId: string,
  resource: string,
  scope: string,
  secret: string,
): Promise<Response> {
  const now = nowSeconds()
  const accessToken = await signToken<AccessTokenPayload>(
    'access',
    {
      clientId,
      aud: resource,
      scope,
      sub: 'canvas-owner',
      exp: now + ACCESS_TTL_SECONDS,
    },
    secret,
  )
  const refreshToken = await signToken<RefreshTokenPayload>(
    'refresh',
    {
      clientId,
      resource,
      scope,
      sub: 'canvas-owner',
      exp: now + REFRESH_TTL_SECONDS,
    },
    secret,
  )
  return json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  })
}

async function exchangeToken(request: Request, secret: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  if (!hasContentType(request, 'application/x-www-form-urlencoded')) {
    return oauthError(
      'invalid_request',
      'Content-Type must be application/x-www-form-urlencoded.',
      415,
    )
  }
  const params = await readForm(request)
  if (!params) return oauthError('invalid_request', 'Malformed or oversized token request.')
  const grantType = params.get('grant_type')
  const clientId = params.get('client_id') ?? ''
  if (grantType === 'authorization_code') {
    const code = await verifyToken<AuthorizationCodePayload>(
      params.get('code') ?? '',
      'code',
      secret,
    )
    const redirectUri = params.get('redirect_uri') ?? ''
    const resource = canonicalResource(params.get('resource') ?? MCP_RESOURCE)
    const scope = code?.s === 1 ? `${OAUTH_SCOPE} ${OPTIONAL_OFFLINE_SCOPE}` : OAUTH_SCOPE
    if (!code || !resource || (code.s !== 0 && code.s !== 1)) {
      return oauthError('invalid_grant', 'Authorization code is invalid or expired.')
    }
    const binding = await authorizationCodeBinding(clientId, redirectUri, resource, scope)
    if (
      !(await constantTimeEqual(binding, code.b)) ||
      !(await verifyPkce(params.get('code_verifier') ?? '', code.p))
    ) {
      return oauthError('invalid_grant', 'Authorization code is invalid or expired.')
    }
    return issueTokens(clientId, resource, scope, secret)
  }
  if (grantType === 'refresh_token') {
    const refresh = await verifyToken<RefreshTokenPayload>(
      params.get('refresh_token') ?? '',
      'refresh',
      secret,
    )
    if (!refresh || refresh.clientId !== clientId) {
      return oauthError('invalid_grant', 'Refresh token is invalid or expired.', 401)
    }
    const resource = canonicalResource(params.get('resource') ?? refresh.resource)
    if (resource !== refresh.resource) {
      return oauthError('invalid_target', 'The resource must be the one authorized.')
    }
    if (params.has('scope') && normalizeScope(params.get('scope')) !== refresh.scope) {
      return oauthError('invalid_scope', 'The requested scope cannot exceed the authorized scope.')
    }
    return issueTokens(clientId, resource, refresh.scope, secret)
  }
  return oauthError(
    'unsupported_grant_type',
    'Only authorization_code and refresh_token are supported.',
  )
}

export async function verifyOAuthAccessToken(token: string, secret: string): Promise<boolean> {
  const payload = await verifyToken<AccessTokenPayload>(token, 'access', secret)
  return (
    payload !== null &&
    payload.aud === MCP_RESOURCE &&
    payload.sub === 'canvas-owner' &&
    payload.scope.split(/\s+/).includes(OAUTH_SCOPE)
  )
}

export function oauthResourceMetadataUrl(): string {
  return `${CANONICAL_ORIGIN}${PROTECTED_RESOURCE_METADATA_PATH}`
}

export async function handleOAuthRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (
    url.pathname === '/.well-known/oauth-protected-resource' ||
    url.pathname === PROTECTED_RESOURCE_METADATA_PATH
  ) {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    return json(protectedResourceMetadata())
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    return json(authorizationServerMetadata())
  }
  if (
    (url.pathname.startsWith('/oauth/') ||
      ['/authorize', '/register', '/token'].includes(url.pathname)) &&
    (!env.OWNER_SECRET || env.OWNER_SECRET.length < 32)
  ) {
    return oauthError('temporarily_unavailable', 'OAuth is not configured.', 503)
  }
  // Existing clients can cache the former server's root-level OAuth endpoints.
  if (url.pathname === '/oauth/register' || url.pathname === '/register') {
    return registerClient(request, env.OWNER_SECRET)
  }
  if (url.pathname === '/oauth/authorize' || url.pathname === '/authorize') {
    if (request.method === 'GET') return authorizeGet(request, env.OWNER_SECRET)
    if (request.method === 'POST') return authorizePost(request, env.OWNER_SECRET)
    return methodNotAllowed('GET, POST')
  }
  if (url.pathname === '/oauth/token' || url.pathname === '/token') {
    return exchangeToken(request, env.OWNER_SECRET)
  }
  return null
}
