import type { SceneLifeOverlay } from '@possibility/scene-contract'
import type { WorldSnapshot } from '../../api/types'
import {
  environmentLocationVisuals,
  firstEnvironmentValue,
  projectEnvironmentFacts,
  type TimelineEnvironmentProjection,
} from './environment'

export function buildSceneOverlay(
  snapshot: WorldSnapshot,
  timelineId = snapshot.currentTimelineId,
  environment: TimelineEnvironmentProjection = projectEnvironmentFacts(
    snapshot.currentFacts.map(fact => ({ value: fact.value, factType: fact.factType })),
  ),
): SceneLifeOverlay {
  const hour = new Date(snapshot.simNow).getUTCHours()
  const timeOfDay: SceneLifeOverlay['timeOfDay'] = hour >= 6 && hour < 17 ? 'day' : hour >= 17 && hour < 20 ? 'dusk' : hour >= 5 && hour < 6 ? 'dawn' : 'night'
  const weatherFact = firstEnvironmentValue(environment, 'weather')
  const lightingFact = firstEnvironmentValue(environment, 'lighting')
  const weather = weatherFact?.label ?? null
  const lighting = lightingFact?.value === 'day' || lightingFact?.value === 'dusk' || lightingFact?.value === 'night'
    ? lightingFact.value
    : null
  const persons = snapshot.locationBoard.flatMap(location => location.persons.map(person => ({ personId: person.id, locationName: location.location, activity: person.activity, mood: '' })))
  const locationStates = environmentLocationVisuals(environment)
  return {
    timelineId, simNow: snapshot.simNow, weather, timeOfDay,
    // Optional so existing scene-contract consumers remain source-compatible;
    // when present it is the finite projection value, never free text.
    lighting,
    persons, locationStates,
  }
}
