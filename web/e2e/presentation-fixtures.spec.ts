import { expect, test } from '@playwright/test'
import { createPresentationFixtures } from './presentation.fixtures'

test('comparison fixtures isolate world, time, capabilities and response ownership', () => {
  const first = createPresentationFixtures()
  const second = createPresentationFixtures()
  expect(first.left.bootstrap.world.world.id).not.toBe(first.right.bootstrap.world.world.id)
  expect(first.left.bootstrap.world.simNow).not.toBe(first.right.bootstrap.world.simNow)
  expect(first.left.bootstrap.world.stateVersion).not.toBe(first.right.bootstrap.world.stateVersion)
  expect(first.left.bootstrap.access.editScene).toBe(true)
  expect(first.right.bootstrap.access.editScene).toBe(false)
  expect(first.left.bootstrap.scene).not.toBe(first.right.bootstrap.scene)
  first.left.bootstrap.access.observe = false
  first.left.bootstrap.world.world.name = 'Changed in this test'
  expect(first.right.bootstrap.access.observe).toBe(true)
  expect(second.left.bootstrap.access.observe).toBe(true)
  expect(second.left.bootstrap.world.world.name).not.toBe('Changed in this test')
})

test('same-world fixtures preserve independent timelines and guest permissions', () => {
  const pair = createPresentationFixtures({ sameWorld: true, leftIdentity: 'guest', rightIdentity: 'owner' })
  expect(pair.left.bootstrap.world.world.id).toBe(pair.right.bootstrap.world.world.id)
  expect(pair.left.bootstrap.world.currentTimelineId).not.toBe(pair.right.bootstrap.world.currentTimelineId)
  expect(pair.left.bootstrap.access.fork).toBe(true)
  expect(pair.left.bootstrap.access.persist).toBe(false)
  expect(pair.right.bootstrap.access.persist).toBe(true)
})
