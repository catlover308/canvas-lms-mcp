import type { McpServer } from '@modelcontextprotocol/server'
import type { CanvasClient } from '../canvas'
import { registerAssignmentDescriptionResource } from './assignment-description'
import { registerSyllabusResource } from './syllabus'

/** Register Canvas data resources without the optional MCP Apps frontend resources. */
export function registerCanvasResources(server: McpServer, canvas: CanvasClient): void {
  registerSyllabusResource(server, canvas)
  registerAssignmentDescriptionResource(server, canvas)
}
