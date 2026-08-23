function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)])
  let difference = 0
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest[index]! ^ rightDigest[index]!
  }
  return difference === 0
}

/**
 * Authenticate a remote MCP request without ever forwarding or returning the
 * credential. Access tokens in URI query strings are intentionally unsupported.
 */
export async function isAuthorizedMcpRequest(
  request: Request,
  expectedToken: string,
): Promise<boolean> {
  if (!expectedToken) return false
  const suppliedToken = readBearerToken(request)
  return suppliedToken !== null && (await constantTimeEqual(suppliedToken, expectedToken))
}

/** Remove the MCP credential before handing the request to third-party code. */
export function stripMcpAuthorization(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.delete('Authorization')
  return new Request(request, { headers })
}

export function unauthorizedMcpResponse(): Response {
  return Response.json(
    {
      error: 'unauthorized',
      message: 'A valid MCP access credential is required.',
    },
    {
      status: 401,
      headers: {
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Bearer realm="canvas-lms-mcp"',
      },
    },
  )
}
