const locations = [
  ['河畔住区', '安静的居民街巷'],
  ['街角咖啡馆', '邻里相遇的咖啡馆'],
  ['社区杂货铺', '日常采购的小店'],
  ['河边书屋', '临河阅读空间'],
  ['旧车站', '连接社区的站点'],
]

/** Deterministic model-provider substitute, injected only by the isolated s02-e2e Wrangler config. */
export async function s02SceneFixture(request: Request): Promise<Response> {
  const payload = await request.json() as { messages: { content: string }[] }
  const userMessage = JSON.parse(payload.messages.at(-1)?.content ?? '{}') as { selectedResidents?: { id: string }[]; description?: string }
  const residentId = userMessage.selectedResidents?.[0]?.id
  if (!residentId) return Response.json({ error: 'selectedResidents missing' }, { status: 400 })
  const buildings = ['home-small', 'cafe-corner', 'grocery-small', 'bookshop-small', 'station-stop']
  const positions = [{ x: 1, y: 1 }, { x: 7, y: 1 }, { x: 14, y: 1 }, { x: 1, y: 9 }, { x: 8, y: 9 }]
  const objects: Record<string, unknown>[] = buildings.map((assetId, index) => ({
    id: `fixture-place-${index}`,
    assetId,
    position: positions[index]!,
    binding: { kind: 'location', locationName: locations[index]![0] },
    label: locations[index]![0],
    purpose: locations[index]![1],
  }))
  objects.push({ id: 'fixture-resident', assetId: 'person-ada', position: { x: 15, y: 12 }, binding: { kind: 'person', personId: residentId }, label: 'Ada', purpose: null })
  const result = {
    world: { name: '河畔日常', description: userMessage.description ?? '一方临河生活的天地', locations: locations.map(([name, description]) => ({ name, description })) },
    scene: { schemaVersion: 1, themeId: 'contemporary-daily-life', size: { columns: 24, rows: 18 }, version: 0, terrain: [], paths: [], objects, lockedObjectIds: [], lockedAreas: [] },
    explanation: '已将住宅、咖啡馆、商店、书屋和车站安排在河畔。',
    warnings: [],
  }
  return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
}
