import { ResourceTemplate } from '@modelcontextprotocol/server'
import type { McpServer } from '@modelcontextprotocol/server'
import type { CanvasClient } from '../canvas'
import { CanvasApiError } from '../canvas/client'
import { CANYONS_NOT_CONFIGURED_MESSAGE } from '../institutions'
import { RESOURCE_LABELS } from '../provenance/fields'
import { fenceBlock, isProvenanceFencingEnabled } from '../provenance/markers'
import { formatError } from '../tools'

export interface AssignmentDescriptionResourceOptions {
  name?: string
  uriTemplate?: string
}

function fenceDescription(description: string): string {
  if (description.length === 0 || !isProvenanceFencingEnabled()) return description
  return fenceBlock(description, RESOURCE_LABELS.assignmentDescription)
}

export function registerAssignmentDescriptionResource(
  server: McpServer,
  canvas: CanvasClient | undefined,
  options: AssignmentDescriptionResourceOptions = {},
): void {
  const uriTemplate =
    options.uriTemplate ?? 'canvas://course/{courseId}/assignment/{assignmentId}/description'
  const template = new ResourceTemplate(uriTemplate, { list: undefined })

  server.registerResource(
    options.name ?? 'assignment-description',
    template,
    { mimeType: 'text/html' },
    async (_uri, variables) => {
      const courseId = Number(variables.courseId)
      const assignmentId = Number(variables.assignmentId)
      const uri = uriTemplate
        .replace('{courseId}', String(variables.courseId))
        .replace('{assignmentId}', String(variables.assignmentId))
      if (Number.isNaN(courseId) || Number.isNaN(assignmentId)) {
        return {
          contents: [{ uri, mimeType: 'text/plain', text: 'Invalid course or assignment ID' }],
        }
      }
      if (!canvas) {
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: CANYONS_NOT_CONFIGURED_MESSAGE,
            },
          ],
        }
      }
      try {
        const assignment = await canvas.assignments.get(courseId, assignmentId)
        return {
          contents: [
            {
              uri,
              mimeType: 'text/html',
              // Fenced here because resources bypass buildHandler (BRU-2104 §8.2).
              text: fenceDescription(assignment.description ?? ''),
            },
          ],
        }
      } catch (error) {
        if (!(error instanceof CanvasApiError)) {
          console.error('Unexpected error in assignment-description resource:', error)
        }
        return {
          contents: [{ uri, mimeType: 'text/plain', text: formatError(error) }],
        }
      }
    },
  )
}
