import { universeEvidence, universeRevisions, worldModelVersions } from '../api/src/db/schema'
import { createWorldFixture, WORLD_TIME } from '../api/src/test/world-fixture'
import { PROJECTION_DOMAINS, createRootProjectionBaseline } from '../api/src/world-state/model'
import { assessAndUpgradeUniverse, classifyUniverse } from '../api/src/world-state/classification'

const safeModel = (extra: Record<string, unknown> = {}) => ({
  name: 'S01 isolated legacy fixture', description: '', locations: [], residents: [], ...extra,
})

async function main() {
  const fixtures = await Promise.all([createWorldFixture(), createWorldFixture(), createWorldFixture()])
  try {
    const [complete, upgradeable, incomplete] = fixtures
    const pin = async (fixture: typeof complete, model: Record<string, unknown>) => {
      await fixture.db.delete(universeEvidence)
      await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1,
        modelJson: JSON.stringify(model), createdAt: WORLD_TIME })
      await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0,
        simTime: WORLD_TIME, worldModelVersion: 1, updatedAt: WORLD_TIME })
    }

    await pin(complete, safeModel({ projectionBaseline: createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, []) }))
    await pin(upgradeable, safeModel({ initialStates: { capturedAt: WORLD_TIME, states: [] },
      initialEvents: { timelineId: 'home-main', eventIds: [] } }))
    await pin(incomplete, safeModel({ initialStates: { capturedAt: WORLD_TIME, states: [] },
      initialEvents: { timelineId: 'home-main', eventIds: ['unrecoverable-event'] } }))

    const completeResult = await classifyUniverse(complete.db, 'home-world', 'home-main')
    const upgradeResult = await classifyUniverse(upgradeable.db, 'home-world', 'home-main')
    const incompleteResult = await classifyUniverse(incomplete.db, 'home-world', 'home-main')
    if (completeResult.level !== 'complete' || upgradeResult.level !== 'upgradeable'
      || incompleteResult.level !== 'incomplete') throw new Error('Legacy classification did not match the three expected evidence levels')
    if (upgradeResult.upgradeBaseline?.completeDomains.join(',') !== PROJECTION_DOMAINS.join(',')) {
      throw new Error('Upgradeable legacy baseline does not cover every projection domain')
    }

    const upgraded = await assessAndUpgradeUniverse(upgradeable.db, 'home-world', 'home-main', WORLD_TIME)
    if (upgraded.after.level !== 'complete') throw new Error('Upgradeable legacy fixture did not pass post-upgrade review')
    const persisted = await incomplete.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'incomplete',
      assessedVersion: 0, baselineVersion: null, reasonCodesJson: JSON.stringify(incompleteResult.reasonCodes), assessedAt: WORLD_TIME })
      .onConflictDoNothing().returning().get()
    if (!persisted) throw new Error('Could not persist the incomplete fixture classification')

    // The commit boundary must fail closed for incomplete histories without writing commands or facts.
    const writeGate = await import('../api/src/engine/guard')
    const gate = await writeGate.gateUniverseWrite(incomplete.db, 'home-world', 'home-main')
    const commands = Number(incomplete.sqlite.prepare('SELECT COUNT(*) AS n FROM world_commands').get()?.n ?? -1)
    const facts = Number(incomplete.sqlite.prepare('SELECT COUNT(*) AS n FROM world_facts').get()?.n ?? -1)
    if (gate.ok !== false || commands !== 0 || facts !== 0) {
      throw new Error('Incomplete fixture did not fail closed before writing history')
    }

    const levels = await Promise.all(fixtures.map(async fixture => {
      const rows = await fixture.db.select().from(universeEvidence).all()
      return rows.map(row => row.level)
    }))
    const flattened = levels.flat()
    const summary = { isolatedDatabases: fixtures.length, classified: 3, upgraded: upgraded.after.level === 'complete' ? 1 : 0,
      incompleteWriteRejected: true, unassessed: flattened.filter(level => level === 'unassessed').length,
      upgradeable: flattened.filter(level => level === 'upgradeable').length,
      incomplete: flattened.filter(level => level === 'incomplete').length, remote: false, modelCalls: 0 }
    if (summary.unassessed || summary.upgradeable || summary.incomplete !== 1) {
      throw new Error(`Legacy final evidence counts were unexpected: ${JSON.stringify(summary)}`)
    }
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    for (const fixture of fixtures) fixture.close()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
