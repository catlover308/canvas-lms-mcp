import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CanvasClient } from '../src/canvas'
import { registerMultiInstitutionTools } from '../src/worker-tools'

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

describe('multi-institution Worker tool registry', () => {
  function captureRegistry() {
    const handlers = new Map<string, (params: Record<string, unknown>) => Promise<ToolResponse>>()
    const configs = new Map<string, { inputSchema: z.ZodType }>()
    const server = {
      registerTool: (name: string, config: { inputSchema: z.ZodType }, handler: unknown) => {
        configs.set(name, config)
        handlers.set(name, handler as (params: Record<string, unknown>) => Promise<ToolResponse>)
      },
    } as unknown as McpServer

    const pasadena = new CanvasClient({
      token: 'pasadena-token',
      baseUrl: 'https://canvas.pasadena.edu',
    })
    const canyons = new CanvasClient({
      token: 'canyons-token',
      baseUrl: 'https://coc.instructure.com',
    })
    const pasadenaHealth = vi.spyOn(pasadena.users, 'getProfile').mockResolvedValue({ id: 1 })
    const canyonsHealth = vi.spyOn(canyons.users, 'getProfile').mockResolvedValue({ id: 2 })
    const canyonsCreateAssignment = vi
      .spyOn(canyons.assignments, 'create')
      .mockResolvedValue({ id: 99, name: 'Essay' } as never)

    registerMultiInstitutionTools(server, { pasadena, canyons })
    return { handlers, configs, pasadenaHealth, canyonsHealth, canyonsCreateAssignment }
  }

  it('keeps one 165-tool registry and adds the institution selector to every schema', () => {
    const { handlers, configs } = captureRegistry()
    expect(handlers.size).toBe(165)
    expect(configs.size).toBe(165)

    for (const [name, config] of configs) {
      const institution = (config.inputSchema as z.ZodObject).shape.institution as z.ZodType
      expect(institution, name).toBeDefined()
      expect(institution.parse(undefined), name).toBe('pasadena')
      expect(institution.parse('canyons'), name).toBe('canyons')
    }
  })

  it('defaults calls to Pasadena and routes institution="canyons" to its isolated client', async () => {
    const { handlers, pasadenaHealth, canyonsHealth } = captureRegistry()
    const health = handlers.get('health_check')
    expect(health).toBeDefined()

    await health!({})
    expect(pasadenaHealth).toHaveBeenCalledOnce()
    expect(canyonsHealth).not.toHaveBeenCalled()

    await health!({ institution: 'canyons' })
    expect(pasadenaHealth).toHaveBeenCalledOnce()
    expect(canyonsHealth).toHaveBeenCalledOnce()
  })

  it('consumes the institution selector instead of leaking it into Canvas payloads', async () => {
    const { handlers, canyonsCreateAssignment } = captureRegistry()
    const createAssignment = handlers.get('create_assignment')
    expect(createAssignment).toBeDefined()

    await createAssignment!({ institution: 'canyons', course_id: 42, name: 'Essay' })
    expect(canyonsCreateAssignment).toHaveBeenCalledWith(42, { name: 'Essay' })
  })

  it('keeps all tools discoverable and returns an explicit error while Canyons is dormant', async () => {
    const handlers = new Map<string, (params: Record<string, unknown>) => Promise<ToolResponse>>()
    const server = {
      registerTool: (name: string, _config: unknown, handler: unknown) => {
        handlers.set(name, handler as (params: Record<string, unknown>) => Promise<ToolResponse>)
      },
    } as unknown as McpServer
    const pasadena = new CanvasClient({
      token: 'pasadena-token',
      baseUrl: 'https://canvas.pasadena.edu',
    })

    registerMultiInstitutionTools(server, { pasadena })

    expect(handlers.size).toBe(165)
    const result = await handlers.get('health_check')!({ institution: 'canyons' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Canyons Canvas is dormant')
  })
})
