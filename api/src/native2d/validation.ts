import { validateConnectivity, cellKey, inBounds, isGridPoint } from './connectivity'
import type {
  Native2dBuildingBinding,
  Native2dLayout,
  Native2dPlacement,
  Native2dSpaceBinding,
  Native2dValidationIssue,
  Native2dValidationResult,
} from './schema'

const issue = (value: Native2dValidationIssue): Native2dValidationIssue => value

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function validateBindings(layout: Native2dLayout): Native2dValidationIssue[] {
  const result: Native2dValidationIssue[] = []
  const spaceIds = new Set<string>()
  const buildingIds = new Set<string>()
  for (const space of layout.metadata.spaces) {
    if (!isRecord(space)) {
      result.push(issue({ code: 'invalid_space', message: 'Space binding must be an object' }))
      continue
    }
    const walkable = Array.isArray(space.walkable) ? space.walkable : null
    const blocked = space.blocked === undefined || Array.isArray(space.blocked) ? space.blocked ?? [] : null
    if (!validText(space.spaceId) || spaceIds.has(space.spaceId) || !Number.isSafeInteger(space.width) || !Number.isSafeInteger(space.depth) || space.width <= 0 || space.depth <= 0 || !walkable || !blocked) {
      result.push(issue({ code: 'invalid_space', spaceId: space.spaceId, message: `Invalid or duplicate space ${space.spaceId}` }))
      continue
    }
    spaceIds.add(space.spaceId)
    if (!walkable.every(isGridPoint) || blocked.some((point) => !isGridPoint(point))) {
      result.push(issue({ code: 'invalid_space', spaceId: space.spaceId, message: `Space ${space.spaceId} contains invalid cells` }))
    }
  }
  for (const building of layout.metadata.buildings) {
    if (!isRecord(building)) {
      result.push(issue({ code: 'invalid_binding', message: 'Building binding must be an object' }))
      continue
    }
    if (!validText(building.buildingId) || buildingIds.has(building.buildingId)) {
      result.push(issue({ code: 'invalid_binding', buildingId: building.buildingId, message: `Invalid or duplicate building ${building.buildingId}` }))
      continue
    }
    buildingIds.add(building.buildingId)
    const footprint = Array.isArray(building.footprint) ? building.footprint : null
    if (!spaceIds.has(building.spaceId) || !footprint || footprint.length === 0 || !footprint.every(isGridPoint)) {
      result.push(issue({ code: 'invalid_binding', buildingId: building.buildingId, spaceId: building.spaceId, message: `Building ${building.buildingId} has an invalid space or footprint` }))
    }
    if (building.entry !== undefined && building.entry !== null && !isGridPoint(building.entry)) {
      result.push(issue({ code: 'invalid_binding', buildingId: building.buildingId, message: `Entry for ${building.buildingId} is not a grid point` }))
    }
    if (building.interiorSpaceId !== undefined && building.interiorSpaceId !== null) {
      const interior = layout.metadata.spaces.find((space) => isRecord(space) && space.spaceId === building.interiorSpaceId)
      if (!interior || interior.kind !== 'interior') result.push(issue({ code: 'invalid_binding', buildingId: building.buildingId, message: `Interior space for ${building.buildingId} does not exist or is not interior` }))
    }
  }
  return result
}

function validatePlacements(layout: Native2dLayout): Native2dValidationIssue[] {
  const result: Native2dValidationIssue[] = []
  const spaces = new Map(layout.metadata.spaces.filter(isRecord).map((space) => [space.spaceId, space]))
  const bindings = new Map(layout.metadata.buildings.filter(isRecord).map((building) => [building.buildingId, building]))
  const expected = new Set(bindings.keys())
  const seen = new Set<string>()
  const occupancy = new Map<string, string>()
  for (const placement of layout.placements) {
    if (!isRecord(placement)) {
      result.push(issue({ code: 'invalid_placement', message: 'Placement must be an object' }))
      continue
    }
    const binding = bindings.get(placement.buildingId)
    const space = spaces.get(placement.spaceId)
    if (!binding || !space || !Array.isArray(binding.footprint) || !binding.footprint.every(isGridPoint)
      || !Array.isArray(space.walkable) || !space.walkable.every(isGridPoint)
      || !Array.isArray(space.blocked ?? []) || !(space.blocked ?? []).every(isGridPoint)
      || seen.has(placement.buildingId)
      || binding.spaceId !== placement.spaceId || !isGridPoint(placement.origin)) {
      result.push(issue({ code: 'invalid_placement', buildingId: placement.buildingId, spaceId: placement.spaceId, message: `Invalid placement for ${placement.buildingId}` }))
      continue
    }
    seen.add(placement.buildingId)
    for (const offset of binding.footprint) {
      const point = { x: placement.origin.x + offset.x, z: placement.origin.z + offset.z }
      const key = `${space.spaceId}|${cellKey(point)}`
      if (!inBounds(point, space)) result.push(issue({ code: 'out_of_bounds', buildingId: binding.buildingId, spaceId: space.spaceId, message: `${binding.buildingId} is out of bounds`, cells: [point] }))
      if (!space.walkable.some((cell) => cellKey(cell) === cellKey(point))) result.push(issue({ code: 'blocked', buildingId: binding.buildingId, spaceId: space.spaceId, message: `${binding.buildingId} is on a non-walkable cell`, cells: [point] }))
      if ((space.blocked ?? []).some((cell) => cellKey(cell) === cellKey(point))) result.push(issue({ code: 'blocked', buildingId: binding.buildingId, spaceId: space.spaceId, message: `${binding.buildingId} overlaps a blocked cell`, cells: [point] }))
      const prior = occupancy.get(key)
      if (prior) result.push(issue({ code: 'collision', buildingId: binding.buildingId, spaceId: space.spaceId, message: `${binding.buildingId} overlaps ${prior}`, cells: [point] }))
      else occupancy.set(key, binding.buildingId)
    }
  }
  for (const buildingId of expected) if (!seen.has(buildingId)) result.push(issue({ code: 'invalid_placement', buildingId, message: `Missing placement for ${buildingId}` }))
  return result
}

export function validateNative2dLayout(layout: Native2dLayout): Native2dValidationResult {
  const issues: Native2dValidationIssue[] = []
  if (!layout || typeof layout !== 'object' || !layout.metadata || typeof layout.metadata !== 'object' || !Array.isArray(layout.metadata.spaces) || !Array.isArray(layout.metadata.buildings) || !Array.isArray(layout.placements)) {
    return { valid: false, issues: [{ code: 'invalid_metadata', message: 'Native2d layout is not a complete object' }] }
  }
  if (layout.metadata.schema !== 'native2d-layout' || layout.metadata.schemaVersion !== 1 || layout.metadata.layoutVersion !== 1 || !Number.isSafeInteger(layout.metadata.sceneVersion) || layout.metadata.sceneVersion < 0) {
    issues.push(issue({ code: 'invalid_metadata', message: 'Unsupported native2d metadata version' }))
  }
  if (!validText(layout.metadata.worldId) || !validText(layout.metadata.timelineId) || !validText(layout.metadata.sceneId)) issues.push(issue({ code: 'invalid_scope', message: 'Native2d scope is incomplete' }))
  issues.push(...validateBindings(layout), ...validatePlacements(layout))
  if (issues.length === 0) issues.push(...validateConnectivity(layout))
  return { valid: issues.length === 0, issues }
}

export const validateLayout = validateNative2dLayout
