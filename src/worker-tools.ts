import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { CanvasClient } from './canvas'
import type {
  CanvasAssignment,
  CanvasCourse,
  CanvasEnrollment,
  CanvasMissingSubmission,
  CanvasModuleItem,
  CanvasTodoItem,
  CanvasUpcomingEvent,
} from './canvas/types'
import { registerToolDefinitions } from './tools'
import type { ToolDefinition } from './tools/types'

export const WORKER_CONTRACT_VERSION = 'canvas-cloud-v1'
export const WORKER_SOURCE_REPOSITORY = 'https://github.com/catlover308/canvas-lms-mcp'
export const WORKER_TOOL_NAMES = [
  'get_student_dashboard',
  'list_courses',
  'get_course_summary',
  'list_assignments',
  'get_assignment_details',
  'get_content_item',
] as const

const COURSE_IDENTIFIER = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe('Canvas course ID, course code, or exact course name')
const DETAIL = z.enum(['compact', 'standard', 'full']).default('compact')
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

type Detail = 'compact' | 'standard' | 'full'

function normalizeIdentifier(value: string | number): string {
  return String(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

async function resolveCourse(
  canvas: CanvasClient,
  identifier: string | number,
): Promise<CanvasCourse> {
  const raw = String(identifier).trim()
  if (/^\d+$/.test(raw)) {
    return canvas.courses.get(Number(raw), { include: ['term'] })
  }

  const target = normalizeIdentifier(identifier)
  const courses = await canvas.courses.list({ include: ['term'] })
  const matches = courses.filter(
    (course) =>
      normalizeIdentifier(course.course_code) === target ||
      normalizeIdentifier(course.name) === target,
  )
  if (matches.length === 0) {
    throw new Error(`No visible Canvas course matches ${JSON.stringify(String(identifier))}.`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Canvas course identifier ${JSON.stringify(String(identifier))} is ambiguous; use the numeric course ID.`,
    )
  }
  return matches[0]!
}

function courseSummary(course: CanvasCourse): Record<string, unknown> {
  return {
    id: course.id,
    code: course.course_code,
    name: course.name,
    state: course.workflow_state,
    term: course.term?.name ?? null,
  }
}

function assignmentSummary(
  assignment: CanvasAssignment | CanvasMissingSubmission,
  course?: CanvasCourse,
): Record<string, unknown> {
  const submission = 'submission' in assignment ? assignment.submission : undefined
  const ownSubmission = Array.isArray(submission) ? submission[0] : submission
  return {
    id: assignment.id,
    course_id: assignment.course_id,
    course: course?.course_code ?? course?.name ?? null,
    name: assignment.name,
    due_at: assignment.due_at,
    points_possible: assignment.points_possible,
    submitted_at: ownSubmission?.submitted_at ?? null,
    missing: ownSubmission?.missing ?? ('submission_types' in assignment ? true : null),
    late: ownSubmission?.late ?? null,
    url: assignment.html_url ?? null,
  }
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function sortWork(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftDue = parseTimestamp(left.due_at as string | null) ?? Number.POSITIVE_INFINITY
  const rightDue = parseTimestamp(right.due_at as string | null) ?? Number.POSITIVE_INFINITY
  if (leftDue !== rightDue) return leftDue - rightDue
  const leftPoints = typeof left.points_possible === 'number' ? left.points_possible : 0
  const rightPoints = typeof right.points_possible === 'number' ? right.points_possible : 0
  if (leftPoints !== rightPoints) return rightPoints - leftPoints
  return String(left.name ?? '').localeCompare(String(right.name ?? ''))
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
}

function contentEnvelope(
  data: Record<string, unknown>,
  detail: Detail,
  truncated = false,
): Record<string, unknown> {
  return {
    data,
    meta: { count: 1, detail, truncated, contract: WORKER_CONTRACT_VERSION },
  }
}

function requireItemIdentifier(
  itemType: string,
  identifier: string | number | null | undefined,
): string | number {
  if (identifier === null || identifier === undefined || String(identifier).trim() === '') {
    throw new Error(`item_identifier is required for item_type=${itemType}.`)
  }
  return identifier
}

function buildWorkerTools(canvas: CanvasClient): ToolDefinition[] {
  return [
    {
      name: 'get_student_dashboard',
      title: 'Get Student Dashboard',
      description:
        'Prioritize your missing, due-soon, peer-review, and Canvas TODO work in one read-only call.',
      inputSchema: {
        course_identifier: COURSE_IDENTIFIER.optional(),
        days_ahead: z.number().int().min(0).max(90).default(7),
        include_overdue: z.boolean().default(true),
        include_missing: z.boolean().default(true),
        include_upcoming: z.boolean().default(true),
        include_grades: z.boolean().default(true),
        include_todos: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(20),
        detail: DETAIL,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (params) => {
        const courseIdentifier = params.course_identifier as string | number | undefined
        const selectedCourse =
          courseIdentifier === undefined ? undefined : await resolveCourse(canvas, courseIdentifier)
        const selectedCourseId = selectedCourse?.id
        const daysAhead = params.days_ahead as number
        const includeOverdue = params.include_overdue as boolean
        const includeMissing = params.include_missing as boolean
        const includeUpcoming = params.include_upcoming as boolean
        const includeGrades = params.include_grades as boolean
        const includeTodos = params.include_todos as boolean
        const limit = params.limit as number
        const detail = params.detail as Detail

        const [courses, missing, upcoming, todos, grades] = await Promise.all([
          canvas.courses.list({ enrollment_state: 'active', include: ['term'] }),
          includeMissing || includeOverdue
            ? canvas.dashboard.getMissingSubmissions()
            : Promise.resolve([]),
          includeUpcoming ? canvas.dashboard.getUpcomingEvents() : Promise.resolve([]),
          includeTodos ? canvas.dashboard.getTodoItems() : Promise.resolve([]),
          includeGrades ? canvas.enrollments.listMyGrades(selectedCourseId) : Promise.resolve([]),
        ])
        const courseMap = new Map(courses.map((course) => [course.id, course]))
        const now = Date.now()
        const windowEnd = now + daysAhead * 24 * 60 * 60 * 1000
        const buckets: Record<string, Array<Record<string, unknown>>> = {
          missing_overdue: [],
          due_within_24_hours: [],
          due_within_window: [],
          required_peer_reviews: [],
          canvas_todos: [],
        }
        const seen = new Set<string>()

        const addAssignment = (
          bucket: keyof typeof buckets,
          assignment: CanvasAssignment | CanvasMissingSubmission,
          deduplicate = true,
        ): void => {
          if (selectedCourseId !== undefined && assignment.course_id !== selectedCourseId) return
          const key = `${assignment.course_id}:${assignment.id}`
          if (deduplicate && seen.has(key)) return
          if (deduplicate) seen.add(key)
          buckets[bucket]!.push(assignmentSummary(assignment, courseMap.get(assignment.course_id)))
        }

        for (const assignment of missing as CanvasMissingSubmission[]) {
          const due = parseTimestamp(assignment.due_at)
          if (
            (due !== null && due < now && includeOverdue) ||
            (due !== null && due >= now && includeMissing) ||
            (due === null && includeMissing)
          ) {
            addAssignment('missing_overdue', assignment)
          }
        }

        for (const event of upcoming as CanvasUpcomingEvent[]) {
          const assignment = event.assignment
          if (!assignment) continue
          const due = parseTimestamp(assignment.due_at ?? event.start_at)
          if (due === null || due < now || due > windowEnd) continue
          addAssignment(
            due <= now + 24 * 60 * 60 * 1000 ? 'due_within_24_hours' : 'due_within_window',
            assignment,
          )
        }

        for (const todo of todos as CanvasTodoItem[]) {
          if (selectedCourseId !== undefined && todo.course_id !== selectedCourseId) continue
          if (todo.type === 'peer_review') {
            buckets.required_peer_reviews!.push({
              id: todo.assignment?.id ?? null,
              name: todo.assignment?.name ?? 'Peer review',
              due_at: todo.assignment?.due_at ?? null,
              course_id: todo.course_id ?? todo.assignment?.course_id ?? null,
              url: todo.html_url,
            })
          } else if (todo.assignment) {
            addAssignment('canvas_todos', todo.assignment as CanvasAssignment, false)
          } else {
            buckets.canvas_todos!.push({
              id: todo.quiz?.id ?? null,
              name: todo.quiz?.title ?? todo.type,
              due_at: todo.quiz?.due_at ?? null,
              course_id: todo.course_id ?? todo.quiz?.course_id ?? null,
              type: todo.type,
              url: todo.html_url,
            })
          }
        }

        for (const items of Object.values(buckets)) items.sort(sortWork)
        const totalBeforeLimit = Object.values(buckets).reduce(
          (sum, items) => sum + items.length,
          0,
        )
        let remaining = limit
        const urgentWork: Record<string, Array<Record<string, unknown>>> = {}
        for (const [name, items] of Object.entries(buckets)) {
          urgentWork[name] = items.slice(0, remaining)
          remaining -= urgentWork[name]!.length
        }

        const gradeData = (grades as CanvasEnrollment[])
          .filter(
            (enrollment) =>
              selectedCourseId === undefined || enrollment.course_id === selectedCourseId,
          )
          .map((enrollment) => ({
            course_id: enrollment.course_id,
            course:
              courseMap.get(enrollment.course_id)?.course_code ??
              courseMap.get(enrollment.course_id)?.name ??
              null,
            current_score: enrollment.grades?.current_score ?? null,
            final_score: enrollment.grades?.final_score ?? null,
            status:
              enrollment.grades?.current_score !== null || enrollment.grades?.final_score !== null
                ? 'available'
                : 'unavailable',
          }))

        return {
          data: {
            courses: courses
              .filter((course) => selectedCourseId === undefined || course.id === selectedCourseId)
              .map(courseSummary),
            urgent_work: urgentWork,
            grades: gradeData,
          },
          meta: {
            count: Object.values(urgentWork).reduce((sum, items) => sum + items.length, 0),
            detail,
            truncated: totalBeforeLimit > limit,
            contract: WORKER_CONTRACT_VERSION,
          },
        }
      },
    },
    {
      name: 'list_courses',
      title: 'List Courses',
      description: 'List courses for the authenticated user.',
      inputSchema: {
        include_all: z.boolean().default(false),
        include_concluded: z.boolean().default(false),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (params) => {
        const includeAll = params.include_all as boolean
        const includeConcluded = params.include_concluded as boolean
        const courses = await canvas.courses.list({
          ...(includeAll ? {} : { enrollment_state: 'active' as const }),
          include: ['term'],
        })
        return courses
          .filter(
            (course) =>
              includeConcluded || (!course.concluded && course.workflow_state !== 'completed'),
          )
          .map(courseSummary)
      },
    },
    {
      name: 'get_course_summary',
      title: 'Get Course Summary',
      description:
        'Read a compact course summary; use get_content_item for syllabus, pages, or modules.',
      inputSchema: { course_identifier: COURSE_IDENTIFIER, detail: DETAIL },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (params) => {
        const detail = params.detail as Detail
        const course = await resolveCourse(canvas, params.course_identifier as string | number)
        const data: Record<string, unknown> = courseSummary(course)
        if (detail !== 'compact') {
          Object.assign(data, {
            start_at: course.start_at ?? null,
            end_at: course.end_at ?? null,
            time_zone: course.time_zone ?? null,
            default_view: course.default_view ?? null,
          })
        }
        if (detail === 'full') data.course = course
        return contentEnvelope(data, detail)
      },
    },
    {
      name: 'list_assignments',
      title: 'List Assignments',
      description: 'List assignments for a specific course.',
      inputSchema: { course_identifier: COURSE_IDENTIFIER },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (params) => {
        const course = await resolveCourse(canvas, params.course_identifier as string | number)
        const assignments = await canvas.assignments.list(course.id, { include: ['submission'] })
        return assignments.map((assignment) => assignmentSummary(assignment, course))
      },
    },
    {
      name: 'get_assignment_details',
      title: 'Get Assignment Details',
      description: 'Get detailed information about a specific assignment.',
      inputSchema: {
        course_identifier: COURSE_IDENTIFIER,
        assignment_id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (params) => {
        const course = await resolveCourse(canvas, params.course_identifier as string | number)
        return canvas.assignments.get(course.id, Number(params.assignment_id), {
          include: ['submission', 'all_dates', 'overrides'],
        })
      },
    },
    {
      name: 'get_content_item',
      title: 'Get Content Item',
      description:
        'Read a course page, front page, syllabus, module, or module item; bodies require standard or full detail.',
      inputSchema: {
        course_identifier: COURSE_IDENTIFIER,
        item_type: z.enum(['page', 'front_page', 'syllabus', 'module', 'module_item']),
        item_identifier: z
          .union([z.string().min(1), z.number().int().positive()])
          .nullable()
          .optional(),
        detail: DETAIL,
        max_chars: z.number().int().min(1).max(100_000).default(4_000),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (params) => {
        const course = await resolveCourse(canvas, params.course_identifier as string | number)
        const itemType = params.item_type as
          'page' | 'front_page' | 'syllabus' | 'module' | 'module_item'
        const detail = params.detail as Detail
        const maxChars = params.max_chars as number
        let data: Record<string, unknown>

        if (itemType === 'syllabus') {
          const body = await canvas.courses.getSyllabus(course.id)
          data = { id: course.id, type: itemType, title: `${course.name} syllabus` }
          if (detail !== 'compact' && body) {
            const plainText = stripHtml(body)
            data.text = plainText.slice(0, maxChars)
            return contentEnvelope(data, detail, plainText.length > maxChars)
          }
          return contentEnvelope(data, detail)
        }

        if (itemType === 'front_page') {
          const page = await canvas.pages.getFrontPage(course.id)
          data = {
            id: page.page_id,
            type: itemType,
            title: page.title,
            published: page.published,
            updated_at: page.updated_at,
            url: page.url,
          }
          if (detail !== 'compact' && page.body) {
            const plainText = stripHtml(page.body)
            data.text = plainText.slice(0, maxChars)
            return contentEnvelope(data, detail, plainText.length > maxChars)
          }
          return contentEnvelope(data, detail)
        }

        if (itemType === 'page') {
          const identifier = requireItemIdentifier(
            itemType,
            params.item_identifier as string | number | null | undefined,
          )
          const page = await canvas.pages.get(course.id, String(identifier))
          data = {
            id: page.page_id,
            type: itemType,
            title: page.title,
            published: page.published,
            updated_at: page.updated_at,
            url: page.url,
          }
          if (detail !== 'compact' && page.body) {
            const plainText = stripHtml(page.body)
            data.text = plainText.slice(0, maxChars)
            return contentEnvelope(data, detail, plainText.length > maxChars)
          }
          return contentEnvelope(data, detail)
        }

        const identifier = requireItemIdentifier(
          itemType,
          params.item_identifier as string | number | null | undefined,
        )
        const structure = await canvas.modules.getCourseStructure(course.id, {
          includeContentDetails: true,
        })
        if (itemType === 'module') {
          const module = structure.modules.find((candidate) => candidate.id === Number(identifier))
          if (!module) throw new Error(`No visible module has ID ${String(identifier)}.`)
          data = { ...module, type: itemType }
          return contentEnvelope(data, detail)
        }

        let moduleItem: CanvasModuleItem | undefined
        let moduleId: number | undefined
        for (const module of structure.modules) {
          const match = module.items.find((candidate) => candidate.id === Number(identifier))
          if (match) {
            moduleItem = { ...match, module_id: module.id }
            moduleId = module.id
            break
          }
        }
        if (!moduleItem) throw new Error(`No visible module item has ID ${String(identifier)}.`)
        data = { ...moduleItem, module_id: moduleId, type: itemType }
        return contentEnvelope(data, detail)
      },
    },
  ]
}

export function registerCanvasCloudTools(server: McpServer, canvas: CanvasClient): void {
  const tools = buildWorkerTools(canvas)
  const names = tools.map((tool) => tool.name)
  if (JSON.stringify(names) !== JSON.stringify(WORKER_TOOL_NAMES)) {
    throw new Error('Canvas Cloud Worker tool registry drifted from its public contract')
  }
  if (
    tools.some(
      (tool) => tool.annotations.readOnlyHint !== true || tool.annotations.destructiveHint === true,
    )
  ) {
    throw new Error('Canvas Cloud Worker attempted to expose a non-read-only tool')
  }
  registerToolDefinitions(server, tools, undefined, { mcpApps: false })
}
