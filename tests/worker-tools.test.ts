import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CanvasClient } from '../src/canvas'
import { registerCanvasCloudTools, WORKER_TOOL_NAMES } from '../src/worker-tools'

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

type ToolConfig = {
  inputSchema: z.ZodType
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

function captureRegistry() {
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<ToolResponse>>()
  const configs = new Map<string, ToolConfig>()
  const server = {
    registerTool: (name: string, config: ToolConfig, handler: unknown) => {
      configs.set(name, config)
      handlers.set(name, handler as (params: Record<string, unknown>) => Promise<ToolResponse>)
    },
  } as unknown as McpServer
  const canvas = new CanvasClient({
    token: 'pasadena-token',
    baseUrl: 'https://canvas.pasadena.edu',
  })
  registerCanvasCloudTools(server, canvas)
  return { canvas, configs, handlers }
}

describe('Canvas Cloud Worker tool registry', () => {
  it('exposes exactly the six client-contract tools, all read-only', () => {
    const { configs, handlers } = captureRegistry()

    expect([...handlers.keys()]).toEqual([...WORKER_TOOL_NAMES])
    expect([...configs.keys()]).toEqual([...WORKER_TOOL_NAMES])
    for (const [name, config] of configs) {
      expect(config.annotations?.readOnlyHint, name).toBe(true)
      expect(config.annotations?.destructiveHint, name).toBe(false)
      expect((config.inputSchema as z.ZodObject).shape.institution, name).toBeUndefined()
    }
  })

  it('resolves a human course code before reading assignments', async () => {
    const { canvas, handlers } = captureRegistry()
    vi.spyOn(canvas.courses, 'list').mockResolvedValue([
      {
        id: 42,
        name: 'College 1',
        course_code: 'COLL 001',
        workflow_state: 'available',
      },
    ] as never)
    const assignments = vi.spyOn(canvas.assignments, 'list').mockResolvedValue([
      {
        id: 9,
        course_id: 42,
        name: 'Orientation',
        description: null,
        due_at: null,
        points_possible: 10,
        grading_type: 'points',
        submission_types: ['online_text_entry'],
        allowed_attempts: -1,
      },
    ] as never)

    const result = await handlers.get('list_assignments')!({ course_identifier: 'coll 001' })

    expect(result.isError).not.toBe(true)
    expect(assignments).toHaveBeenCalledWith(42, { include: ['submission'] })
    expect(JSON.parse(result.content[0]!.text)).toEqual([
      expect.objectContaining({ id: 9, course_id: 42, name: 'Orientation' }),
    ])
  })

  it('fails closed when a course code is ambiguous', async () => {
    const { canvas, handlers } = captureRegistry()
    vi.spyOn(canvas.courses, 'list').mockResolvedValue([
      { id: 1, name: 'College 1 A', course_code: 'COLL 001', workflow_state: 'available' },
      { id: 2, name: 'College 1 B', course_code: 'COLL 001', workflow_state: 'available' },
    ] as never)

    const result = await handlers.get('get_course_summary')!({
      course_identifier: 'COLL 001',
      detail: 'compact',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('ambiguous')
  })
})
