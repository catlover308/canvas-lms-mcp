import type { McpServer } from '@modelcontextprotocol/server'
import type { CanvasClient } from '../canvas'
import { registerCanvasResources } from './canvas'
import { registerCourseStructureUI } from './ui-course-structure'
import { registerAccountNotificationsUI } from './ui-account-notifications'

export { registerCanvasResources } from './canvas'

export function registerAllResources(server: McpServer, canvas: CanvasClient): void {
  registerCanvasResources(server, canvas)
  registerCourseStructureUI(server)
  registerAccountNotificationsUI(server)
}
