import type { McpServer } from '@modelcontextprotocol/server'
import type { CanvasClient } from '../canvas'
import { registerAssignmentDescriptionResource } from './assignment-description'
import { registerSyllabusResource } from './syllabus'

export interface InstitutionResourceClients {
  pasadena: CanvasClient
  canyons?: CanvasClient
}

/** Register explicit resource URIs without changing the upstream Pasadena defaults. */
export function registerInstitutionCanvasResources(
  server: McpServer,
  clients: InstitutionResourceClients,
): void {
  for (const institution of ['pasadena', 'canyons'] as const) {
    const canvas = clients[institution]
    registerSyllabusResource(server, canvas, {
      name: `${institution}-course-syllabus`,
      uriTemplate: `canvas://${institution}/course/{courseId}/syllabus`,
    })
    registerAssignmentDescriptionResource(server, canvas, {
      name: `${institution}-assignment-description`,
      uriTemplate: `canvas://${institution}/course/{courseId}/assignment/{assignmentId}/description`,
    })
  }
}
