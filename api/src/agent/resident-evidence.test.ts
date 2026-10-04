import { describe, expect, it } from 'vitest'
import { dialogues, dialogueTurns, persons, timelines, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { buildResidentEvidence } from './resident-evidence'

describe('resident evidence', () => {
  it('includes utterances only when the resident attended and never includes private thoughts', async () => {
    const fixture = await createWorldFixture()
    try {
      await fixture.db.insert(persons).values([
        { id: 'ada', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME },
        { id: 'bo', userId: 'owner', name: 'Bo', modelJson: '{}', createdAt: WORLD_TIME },
      ])
      await fixture.db.insert(worldPersons).values(['ada', 'bo'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
      await fixture.db.insert(timelines).values({ id: 'fork', worldId: 'home-world', parentTimelineId: 'home-main',
        forkScenarioJson: JSON.stringify({ whatIf: 'creator-only-canary' }), simNow: WORLD_TIME, createdAt: WORLD_TIME })
      await fixture.db.insert(dialogues).values([
        { id: 'attended', timelineId: 'fork', location: 'Cafe', participantIdsJson: '["ada","bo"]', simStart: WORLD_TIME },
        { id: 'unattended', timelineId: 'fork', location: 'Library', participantIdsJson: '["bo"]', simStart: WORLD_TIME },
      ])
      await fixture.db.insert(dialogueTurns).values([
        { id: 'heard', dialogueId: 'attended', turnIndex: 0, personId: 'bo', utterance: 'The bridge opens tomorrow',
          thought: 'private thought should stay hidden', simTime: WORLD_TIME, createdAt: WORLD_TIME },
        { id: 'not-heard', dialogueId: 'unattended', turnIndex: 0, personId: 'bo', utterance: 'Secret from elsewhere',
          thought: 'another private thought', simTime: WORLD_TIME, createdAt: WORLD_TIME },
      ])

      const evidence = await buildResidentEvidence(fixture.db, { timelineId: 'fork', personId: 'ada', knownFacts: [] })
      expect(evidence).toEqual([expect.objectContaining({ sourceId: 'heard', kind: 'utterance', recipientPersonId: 'ada' })])
      expect(JSON.stringify(evidence)).toContain('The bridge opens tomorrow')
      expect(JSON.stringify(evidence)).not.toContain('private thought')
      expect(JSON.stringify(evidence)).not.toContain('Secret from elsewhere')
      expect(JSON.stringify(evidence)).not.toContain('creator-only-canary')

      await fixture.db.insert(timelines).values([
        { id: 'sibling', worldId: 'home-world', parentTimelineId: 'home-main', status: 'archived', simNow: WORLD_TIME, createdAt: WORLD_TIME },
        { id: 'descendant', worldId: 'home-world', parentTimelineId: 'fork', simNow: WORLD_TIME, createdAt: WORLD_TIME,
          status: 'archived',
          forkSnapshotJson: JSON.stringify({ version: 1, sourceTimelineId: 'fork', sourceSimTime: WORLD_TIME, capturedAt: WORLD_TIME,
            ancestorCutoffs: [], states: [], schedules: [], memories: [], events: [], dialogues: [
              { id: 'attended', timelineId: 'fork', location: 'Cafe', participantIdsJson: '["ada","bo"]', simStart: WORLD_TIME },
            ], dialogueTurns: [{ id: 'heard', dialogueId: 'attended', turnIndex: 0, personId: 'bo', utterance: 'The bridge opens tomorrow',
              thought: 'private thought should stay hidden', simTime: WORLD_TIME, createdAt: WORLD_TIME }], commitments: [], historyComplete: true }) },
      ])
      const siblingEvidence = await buildResidentEvidence(fixture.db, { timelineId: 'sibling', personId: 'ada', knownFacts: [] })
      const descendantEvidence = await buildResidentEvidence(fixture.db, { timelineId: 'descendant', personId: 'ada', knownFacts: [] })
      const parentEvidence = await buildResidentEvidence(fixture.db, { timelineId: 'home-main', personId: 'ada', knownFacts: [] })
      expect(siblingEvidence).toEqual([])
      expect(parentEvidence).toEqual([])
      expect(descendantEvidence).toEqual([expect.objectContaining({ sourceId: 'heard', timelineId: 'fork', kind: 'utterance' })])
      expect(JSON.stringify(descendantEvidence)).not.toContain('private thought')
    } finally { fixture.close() }
  })
})
