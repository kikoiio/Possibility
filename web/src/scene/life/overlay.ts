import type { SceneLifeOverlay } from '@possibility/scene-contract'
import type { WorldSnapshot } from '../../api/types'

export function buildSceneOverlay(snapshot: WorldSnapshot, timelineId = snapshot.currentTimelineId): SceneLifeOverlay {
  const hour = new Date(snapshot.simNow).getUTCHours()
  const timeOfDay: SceneLifeOverlay['timeOfDay'] = hour >= 6 && hour < 17 ? 'day' : hour >= 17 && hour < 20 ? 'dusk' : hour >= 5 && hour < 6 ? 'dawn' : 'night'
  const environment = snapshot.currentFacts.filter(fact => fact.factType === 'environment')
  const weatherFact = environment.find(fact => /weather|天气/i.test(String(fact.value.condition ?? '')))
  const weather = typeof weatherFact?.value.value === 'string' ? weatherFact.value.value : null
  const persons = snapshot.locationBoard.flatMap(location => location.persons.map(person => ({ personId: person.id, locationName: location.location, activity: person.activity, mood: '' })))
  const locationStates = environment.map(fact => ({ locationName: typeof fact.value.location === 'string' ? fact.value.location : '世界', visualState: `${String(fact.value.condition ?? '环境')}: ${String(fact.value.value ?? '')}` }))
  return { timelineId, simNow: snapshot.simNow, weather, timeOfDay, persons, locationStates }
}
