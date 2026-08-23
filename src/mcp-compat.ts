const JSON_MEDIA_TYPE = 'application/json'
const SSE_MEDIA_TYPE = 'text/event-stream'

export interface McpRequestCompatibility {
  request: Request
  wantsJsonResponse: boolean
}

function acceptsMediaType(header: string, target: string): boolean {
  const [targetType, targetSubtype] = target.split('/')

  return header.split(',').some((entry) => {
    const [range = '', ...parameters] = entry.split(';')
    const mediaRange = range.trim().toLowerCase()
    const quality = parameters
      .map((parameter) => parameter.trim().match(/^q\s*=\s*(0(?:\.\d*)?|1(?:\.0*)?)$/i))
      .find((match) => match !== null)
    if (quality && Number(quality[1]) === 0) return false

    const [type, subtype] = mediaRange.split('/')
    return (
      (type === '*' && subtype === '*') ||
      (type === targetType && (subtype === '*' || subtype === targetSubtype))
    )
  })
}

/**
 * Canonicalize otherwise usable MCP Accept headers for the SDK's literal
 * media-type check. Explicitly unrelated media types remain rejected.
 */
export function applyMcpRequestCompatibility(request: Request): McpRequestCompatibility {
  if (request.method.toUpperCase() !== 'POST') {
    return { request, wantsJsonResponse: false }
  }

  const accept = request.headers.get('accept')
  const acceptsAnything = accept === null || accept.trim() === ''
  const acceptsJson = acceptsAnything || acceptsMediaType(accept, JSON_MEDIA_TYPE)
  const acceptsSse = acceptsAnything || acceptsMediaType(accept, SSE_MEDIA_TYPE)

  if (!acceptsJson && !acceptsSse) {
    return { request, wantsJsonResponse: false }
  }

  const headers = new Headers(request.headers)
  headers.set('Accept', `${JSON_MEDIA_TYPE}, ${SSE_MEDIA_TYPE}`)

  return {
    request: new Request(request, { headers }),
    wantsJsonResponse: acceptsJson && !acceptsSse,
  }
}

function sseMessageDataStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let beforeData = ''
  let payloadTail = ''
  let foundData = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            const decodedTail = decoder.decode()
            if (foundData) {
              const finalPayload = `${payloadTail}${decodedTail}`.replace(/\r?\n\r?\n$/, '')
              if (finalPayload.length > 0) controller.enqueue(encoder.encode(finalPayload))
              controller.close()
              return
            }

            beforeData += decodedTail
            const match = /(?:^|\r?\n)data: ?/.exec(beforeData)
            if (!match) {
              controller.error(new Error('MCP SSE response ended without a message payload'))
              return
            }
            const finalPayload = beforeData
              .slice(match.index + match[0].length)
              .replace(/\r?\n\r?\n$/, '')
            if (finalPayload.length > 0) controller.enqueue(encoder.encode(finalPayload))
            controller.close()
            return
          }

          const decoded = decoder.decode(value, { stream: true })
          if (!foundData) {
            beforeData += decoded
            const match = /(?:^|\r?\n)data: ?/.exec(beforeData)
            if (!match) {
              // Keep enough suffix to recognize a marker split across chunks,
              // while discarding any number of SSE keepalive comment frames.
              if (beforeData.length > 64) beforeData = beforeData.slice(-64)
              continue
            }
            foundData = true
            payloadTail = beforeData.slice(match.index + match[0].length)
            beforeData = ''
          } else {
            payloadTail += decoded
          }

          // The SDK terminates one stateless message with a blank line. Keep a
          // four-character tail so CRLF and LF endings can be removed at EOF,
          // but stream arbitrarily large tool results without buffering them.
          if (payloadTail.length > 4) {
            const emit = payloadTail.slice(0, -4)
            payloadTail = payloadTail.slice(-4)
            controller.enqueue(encoder.encode(emit))
            return
          }
        }
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
}

/** Return JSON to JSON-only legacy clients while preserving standard MCP SSE. */
export function applyMcpResponseCompatibility(
  response: Response,
  wantsJsonResponse: boolean,
): Response {
  if (
    !wantsJsonResponse ||
    response.body === null ||
    !response.headers.get('content-type')?.toLowerCase().includes(SSE_MEDIA_TYPE)
  ) {
    return response
  }

  const headers = new Headers(response.headers)
  headers.set('Content-Type', JSON_MEDIA_TYPE)
  headers.delete('Content-Length')
  headers.delete('Connection')
  headers.delete('X-Accel-Buffering')

  return new Response(sseMessageDataStream(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
