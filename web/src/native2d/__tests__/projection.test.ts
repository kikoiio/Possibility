import { describe, expect, it } from 'vitest'
import {
  IDENTITY_CAMERA,
  applyCamera,
  gridToProjected,
  gridToScreen,
  projectedToGrid,
  removeCamera,
  projectEnvironmentFor2d,
  screenToGrid,
  snapScreenToGrid,
  snapToGrid,
  type Camera,
} from '../projection'
import { projectEnvironmentFacts } from '../../scene/life/environment'

const REPRESENTATIVE_GRID_POINTS = [
  { x: 0, z: 0 },
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: 7, z: 3 },
  { x: -4, z: 2 },
  { x: 3, z: -5 },
  { x: -8, z: -6 },
  { x: 31, z: 17 },
  { x: -31, z: 17 },
]

const CAMERAS: readonly Camera[] = [
  IDENTITY_CAMERA,
  { pan: { x: 120, y: -48 }, zoom: 1 },
  { pan: { x: 0, y: 0 }, zoom: 2.5 },
  { pan: { x: -333.5, y: 210.25 }, zoom: 0.75 },
  { pan: { x: 512.5, y: 384.75 }, zoom: 1.5 },
]

function expectGridClose(actual: { x: number; z: number }, expected: { x: number; z: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 10)
  expect(actual.z).toBeCloseTo(expected.z, 10)
}

describe('gridToProjected / projectedToGrid', () => {
  it('uses the 64×32 2:1 formula for known cells', () => {
    expect(gridToProjected({ x: 0, z: 0 })).toEqual({ x: 0, y: 0 })
    expect(gridToProjected({ x: 1, z: 0 })).toEqual({ x: 32, y: 16 })
    expect(gridToProjected({ x: 0, z: 1 })).toEqual({ x: -32, y: 16 })
    expect(gridToProjected({ x: 1, z: 1 })).toEqual({ x: 0, y: 32 })
    expect(gridToProjected({ x: 2, z: -1 })).toEqual({ x: 96, y: 16 })
  })

  it('round-trips representative and negative grid points exactly', () => {
    for (const point of REPRESENTATIVE_GRID_POINTS) {
      expect(projectedToGrid(gridToProjected(point))).toEqual(point)
    }
  })

  it('keeps fractional footpoints as decimals through the round trip', () => {
    const footpoint = { x: 3.5, z: -1.25 }
    const back = projectedToGrid(gridToProjected(footpoint))
    expectGridClose(back, footpoint)
  })
})

describe('camera transforms', () => {
  it('applyCamera and removeCamera are exact inverses', () => {
    const camera: Camera = { pan: { x: -100.5, y: 64.25 }, zoom: 1.75 }
    const projected = { x: 160, y: 48 }
    const back = removeCamera(applyCamera(projected, camera), camera)
    expect(back.x).toBeCloseTo(projected.x, 10)
    expect(back.y).toBeCloseTo(projected.y, 10)
  })

  it('round-trips grid points through pan and zoom combinations', () => {
    for (const camera of CAMERAS) {
      for (const point of REPRESENTATIVE_GRID_POINTS) {
        expectGridClose(screenToGrid(gridToScreen(point, camera), camera), point)
      }
    }
  })

  it('zoom and pan never modify the layout grid', () => {
    const cell = { x: 5, z: -2 }
    const identity = gridToScreen(cell, IDENTITY_CAMERA)
    const zoomed = gridToScreen(cell, { pan: { x: 40, y: -20 }, zoom: 3 })
    expect(zoomed).not.toEqual(identity)
    // 同一格在不同相机下逆投影回同一个布局格子。
    expectGridClose(screenToGrid(identity, IDENTITY_CAMERA), cell)
    expectGridClose(screenToGrid(zoomed, { pan: { x: 40, y: -20 }, zoom: 3 }), cell)
    // 投影本身与相机无关。
    expect(gridToProjected(cell)).toEqual({ x: 224, y: 48 })
  })

  it('removes the camera before inverse projection for pointer input', () => {
    const camera: Camera = { pan: { x: 100, y: 50 }, zoom: 2 }
    // 格子 (2, 1) 投影为 (32, 48)，经相机后屏幕点为 (164, 146)。
    expect(gridToScreen({ x: 2, z: 1 }, camera)).toEqual({ x: 164, y: 146 })
    expectGridClose(screenToGrid({ x: 164, y: 146 }, camera), { x: 2, z: 1 })
  })
})

describe('snapToGrid', () => {
  it('rounds fractional targets to the nearest integer cell', () => {
    expect(snapToGrid({ x: 3.4, z: -1.2 })).toEqual({ x: 3, z: -1 })
    expect(snapToGrid({ x: 3.6, z: -1.7 })).toEqual({ x: 4, z: -2 })
    expect(snapToGrid({ x: 0, z: 0 })).toEqual({ x: 0, z: 0 })
  })

  it('rejects non-finite coordinates so they cannot enter edit state', () => {
    expect(snapToGrid({ x: Number.NaN, z: 1 })).toBeNull()
    expect(snapToGrid({ x: 1, z: Number.NaN })).toBeNull()
    expect(snapToGrid({ x: Number.POSITIVE_INFINITY, z: 0 })).toBeNull()
    expect(snapToGrid({ x: 0, z: Number.NEGATIVE_INFINITY })).toBeNull()
  })

  it('returns null when a broken camera makes the inverse projection non-finite', () => {
    const zeroZoom: Camera = { pan: { x: 10, y: 10 }, zoom: 0 }
    expect(snapScreenToGrid({ x: 100, y: 100 }, zeroZoom)).toBeNull()
    const nanPan: Camera = { pan: { x: Number.NaN, y: 0 }, zoom: 1 }
    expect(snapScreenToGrid({ x: 100, y: 100 }, nanPan)).toBeNull()
  })

  it('snaps a panned and zoomed pointer position to the integer cell', () => {
    const camera: Camera = { pan: { x: -50, y: 25 }, zoom: 1.25 }
    // 取格子 (4, -2) 的屏幕点，再附加少量指针偏移后吸附回同一格。
    const screen = gridToScreen({ x: 4, z: -2 }, camera)
    const target = snapScreenToGrid({ x: screen.x + 5, y: screen.y - 2 }, camera)
    expect(target).toEqual({ x: 4, z: -2 })
  })
})

describe('projectEnvironmentFor2d', () => {
  it('keeps finite world weather, lighting and location access for the renderer', () => {
    const projection = projectEnvironmentFacts([
      { factType: 'environment', value: { location: null, condition: 'weather', value: 'fog' } },
      { factType: 'environment', value: { location: null, condition: 'lighting', value: 'night' } },
      { factType: 'environment', value: { location: '大厅', condition: 'access', value: 'closed' } },
      { factType: 'environment', value: { location: '书房', condition: 'access', value: 'restricted' } },
      { factType: 'environment', value: { location: '世界', condition: 'weather', value: 'storm' } },
    ])
    expect(projectEnvironmentFor2d(projection)).toEqual({
      weather: 'fog',
      lighting: 'night',
      access: { 大厅: 'closed' },
    })
  })
})
