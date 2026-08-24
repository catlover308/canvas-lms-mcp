export const CANVAS_INSTITUTIONS = ['pasadena', 'canyons'] as const
export type CanvasInstitution = (typeof CANVAS_INSTITUTIONS)[number]

export const CANYONS_NOT_CONFIGURED_MESSAGE =
  'College of the Canyons Canvas is dormant because no API token is configured.'
