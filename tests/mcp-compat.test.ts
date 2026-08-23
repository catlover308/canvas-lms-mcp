import { describe, expect, it } from 'vitest'
import { applyMcpRequestCompatibility, applyMcpResponseCompatibility } from '../src/mcp-compat'

function request(accept?: string): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (accept !== undefined) headers.set('Accept', accept)
  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
}

describe('MCP HTTP compatibility', () => {
  it.each([
    undefined,
    '*/*',
    'application/json',
    'text/event-stream',
    'application/*',
    'text/*',
    'application/json, text/event-stream',
  ])('canonicalizes usable Accept header %s', (accept) => {
    const result = applyMcpRequestCompatibility(request(accept))
    expect(result.request.headers.get('accept')).toBe('application/json, text/event-stream')
  })

  it('marks JSON-only requests for a JSON response', () => {
    expect(applyMcpRequestCompatibility(request('application/json')).wantsJsonResponse).toBe(true)
    expect(
      applyMcpRequestCompatibility(request('application/json, text/event-stream;q=0'))
        .wantsJsonResponse,
    ).toBe(true)
  })

  it('preserves SSE for wildcard, missing, dual, and SSE-only clients', () => {
    for (const accept of [
      undefined,
      '*/*',
      'text/event-stream',
      'application/json, text/event-stream',
    ]) {
      expect(applyMcpRequestCompatibility(request(accept)).wantsJsonResponse).toBe(false)
    }
  })

  it('leaves explicitly unsupported media types for the MCP handler to reject', () => {
    const original = request('text/plain')
    const result = applyMcpRequestCompatibility(original)
    expect(result.request).toBe(original)
    expect(result.wantsJsonResponse).toBe(false)
  })

  it('honors a specific q=0 exclusion over a wildcard', () => {
    const jsonExcluded = applyMcpRequestCompatibility(request('application/json;q=0, */*;q=1'))
    expect(jsonExcluded.request.headers.get('accept')).toBe('application/json, text/event-stream')
    expect(jsonExcluded.wantsJsonResponse).toBe(false)

    const bothExcluded = request('application/json;q=0, text/event-stream;q=0, */*;q=1')
    const result = applyMcpRequestCompatibility(bothExcluded)
    expect(result.request).toBe(bothExcluded)
    expect(result.wantsJsonResponse).toBe(false)
  })

  it('streams one stateless SSE message as JSON for JSON-only clients', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(': keepalive\n\nevent: mes'))
        controller.enqueue(
          encoder.encode('sage\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'),
        )
        controller.close()
      },
    })
    const response = new Response(source, {
      headers: { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' },
    })

    const compatible = applyMcpResponseCompatibility(response, true)
    expect(compatible.headers.get('content-type')).toBe('application/json')
    expect(compatible.headers.has('x-accel-buffering')).toBe(false)
    expect(await compatible.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
  })

  it('does not alter SSE for clients that accept it', () => {
    const response = new Response('event: message\ndata: {}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
    expect(applyMcpResponseCompatibility(response, false)).toBe(response)
  })
})
