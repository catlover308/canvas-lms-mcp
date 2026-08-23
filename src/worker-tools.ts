import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { CanvasClient } from './canvas'
import { getAllTools, registerToolDefinitions } from './tools'
import type { ToolDefinition } from './tools/types'

export const CANVAS_INSTITUTIONS = ['pasadena', 'canyons'] as const
export type CanvasInstitution = (typeof CANVAS_INSTITUTIONS)[number]

export interface InstitutionClients {
  pasadena: CanvasClient
  canyons: CanvasClient
}

const INSTITUTION_SCHEMA = z
  .enum(CANVAS_INSTITUTIONS)
  .default('pasadena')
  .describe(
    'Canvas institution: "pasadena" for Pasadena City College or "canyons" for College of the Canyons. Defaults to "pasadena".',
  )

function buildInstitutionToolSet(clients: InstitutionClients): ToolDefinition[] {
  const features = { assignmentSubmission: true, mcpApps: false }
  const toolSets = new Map<CanvasInstitution, Map<string, ToolDefinition>>()

  for (const institution of CANVAS_INSTITUTIONS) {
    const definitions = getAllTools(clients[institution], undefined, undefined, features)
    toolSets.set(institution, new Map(definitions.map((tool) => [tool.name, tool])))
  }

  const pasadenaTools = toolSets.get('pasadena')
  if (!pasadenaTools) throw new Error('Pasadena tool registry was not created')

  for (const institution of CANVAS_INSTITUTIONS) {
    const names = toolSets.get(institution)
    if (!names || names.size !== pasadenaTools.size) {
      throw new Error(`Canvas tool registry mismatch for ${institution}`)
    }
    for (const name of pasadenaTools.keys()) {
      if (!names.has(name)) throw new Error(`Canvas tool "${name}" is missing for ${institution}`)
    }
  }

  return [...pasadenaTools.values()].map((pasadenaTool) => ({
    ...pasadenaTool,
    description: `${pasadenaTool.description} Use institution="canyons" for College of the Canyons; omitted institution defaults to Pasadena City College.`,
    inputSchema: {
      institution: INSTITUTION_SCHEMA,
      ...pasadenaTool.inputSchema,
    },
    ui: undefined,
    handler: async (params) => {
      const institution = (params.institution as CanvasInstitution | undefined) ?? 'pasadena'
      const selected = toolSets.get(institution)?.get(pasadenaTool.name)
      if (!selected) throw new Error(`Unknown Canvas institution: ${String(institution)}`)
      // The selector belongs to this adapter, not to Canvas. Several upstream
      // write tools spread their remaining params into request bodies.
      const canvasParams = { ...params }
      delete canvasParams.institution
      return selected.handler(canvasParams)
    },
  }))
}

export function registerMultiInstitutionTools(
  server: McpServer,
  clients: InstitutionClients,
): void {
  registerToolDefinitions(server, buildInstitutionToolSet(clients), undefined, { mcpApps: false })
}
