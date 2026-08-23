import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasClient } from '../../src/canvas'
import { registerInstitutionCanvasResources } from '../../src/resources/institutions'

function mockCanvas(): CanvasClient {
  return {
    courses: { getSyllabus: vi.fn().mockResolvedValue('<p>Syllabus</p>') },
    assignments: { get: vi.fn().mockResolvedValue({ description: '<p>Assignment</p>' }) },
  } as unknown as CanvasClient
}

describe('institution-qualified Canvas resources', () => {
  it('registers distinct Pasadena and Canyons syllabus and assignment resources', () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' })
    const spy = vi.spyOn(server, 'registerResource')

    registerInstitutionCanvasResources(server, {
      pasadena: mockCanvas(),
      canyons: mockCanvas(),
    })

    expect(spy.mock.calls.map((call) => call[0])).toEqual([
      'pasadena-course-syllabus',
      'pasadena-assignment-description',
      'canyons-course-syllabus',
      'canyons-assignment-description',
    ])
    expect(spy).toHaveBeenCalledTimes(4)
  })

  it('routes a Canyons resource URI only through the Canyons client', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' })
    const spy = vi.spyOn(server, 'registerResource')
    const pasadena = mockCanvas()
    const canyons = mockCanvas()

    registerInstitutionCanvasResources(server, { pasadena, canyons })
    const registration = spy.mock.calls.find((call) => call[0] === 'canyons-course-syllabus')
    expect(registration).toBeDefined()
    const handler = registration?.at(-1) as (
      uri: URL,
      variables: Record<string, string>,
    ) => Promise<{ contents: Array<{ uri: string }> }>

    const result = await handler(new URL('canvas://canyons/course/7/syllabus'), { courseId: '7' })
    expect(canyons.courses.getSyllabus).toHaveBeenCalledWith(7)
    expect(pasadena.courses.getSyllabus).not.toHaveBeenCalled()
    expect(result.contents[0]?.uri).toBe('canvas://canyons/course/7/syllabus')
  })
})
