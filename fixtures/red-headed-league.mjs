import { compileGenesisRecords } from '../genesis-records.mjs';

// A small, source-grounded starting point for testing information boundaries.
// It deliberately stops before the novel's bank robbery and leaves the agents
// free to change what happens after the opening state.
export function createRedHeadedLeagueDefinition() {
  const definition = compileGenesisRecords([
    { type: 'world', title: '红发会起点', description: '萨克斯·科堡广场的一间当铺与相邻的地下空间、银行。', weather: '伦敦阴冷的秋日', premise: '威尔逊正按红发会的要求离开当铺，地下有人持续准备着自己的计划。', landscape: 'inland' },
    { type: 'place', id: 'pawnshop', name: '萨克斯·科堡广场当铺', description: '威尔逊经营的当铺，上午十点到下午两点常常无人看守。', space: 'room', grid: [0, 0], landmark: 'none' },
    { type: 'place', id: 'basement', name: '当铺地下室', description: '当铺下方的狭窄地下空间。', space: 'room', grid: [0, 1], landmark: 'none' },
    { type: 'place', id: 'bank', name: 'City and Suburban Bank', description: '与当铺后方相连的银行。', space: 'room', grid: [1, 0], landmark: 'none' },
    { type: 'connection', from: 'pawnshop', to: 'basement' },
    { type: 'connection', from: 'pawnshop', to: 'bank' },
    { type: 'actor', id: 'wilson', name: 'Jabez Wilson', role: '当铺老板', goal: '保住生意并弄清红发会为何解散。', background: '经营当铺多年，最近因红发会的工作每天上午离开店里。', location: 'pawnshop', fatigue: 10 },
    { type: 'actor', id: 'clay', name: 'Vincent Spaulding', role: '当铺伙计', goal: '在不被发现的情况下推进地下计划。', background: '以半工资在当铺工作，喜欢摄影，也熟悉地下空间。', location: 'basement', fatigue: 5 },
    { type: 'actor', id: 'holmes', name: 'Sherlock Holmes', role: '调查者', goal: '依据观察判断当铺附近正在发生什么。', background: '习惯从可重复的现场痕迹中建立行动假设。', location: 'bank', fatigue: 0 },
    { type: 'resource', id: 'spade', name: '挖掘工具', unit: '把', location: 'basement', quantity: 8, capacity: 8, visibility: { actors: ['clay'], clues: [] } },
    { type: 'resource', id: 'tunnel-progress', name: '地下通道进度', unit: '格', location: 'basement', quantity: 0, capacity: 8, visibility: { actors: ['clay'], clues: ['mud-on-floor'] } },
    { type: 'resource', id: 'bank-alert', name: '银行警戒', unit: '格', location: 'bank', quantity: 0, capacity: 3 },
    { type: 'resource', id: 'bank-guard', name: '值守状态', unit: '格', location: 'bank', quantity: 0, capacity: 1 },
    { type: 'resource', id: 'league-attendance', name: '红发会出勤记录', unit: '次', location: 'pawnshop', quantity: 0, capacity: 7, visibility: { actors: ['wilson'], clues: [] } },
    { type: 'process', id: 'bank-notices-tunnel', description: '地下通道进度达到四格后，银行警戒每分钟增加一格。', resourceId: 'bank-alert', deltaPerMinute: 1, when: [{ resourceId: 'tunnel-progress', op: 'gte', value: 4 }] },
    { type: 'action', id: 'dig-tunnel', name: '继续挖掘', description: '消耗一把挖掘工具，让地下通道推进一格。', location: 'basement', costs: [{ resourceId: 'spade', amount: 1 }], gains: [{ resourceId: 'tunnel-progress', amount: 1 }], requires: [{ resourceId: 'tunnel-progress', op: 'lte', value: 7 }], visibility: { actors: ['clay'], clues: [] }, performers: ['clay'] },
    { type: 'action', id: 'raise-alarm', name: '提高警戒', description: '银行提高值守状态。', location: 'bank', costs: [], gains: [{ resourceId: 'bank-guard', amount: 1 }], requires: [{ resourceId: 'bank-alert', op: 'gte', value: 1 }], performers: ['holmes'] },
    { type: 'action', id: 'attend-red-haired-office', name: '继续赴红发会', description: '记录威尔逊继续按要求参加这项工作。', location: 'pawnshop', costs: [], gains: [{ resourceId: 'league-attendance', amount: 1 }], requires: [{ resourceId: 'league-attendance', op: 'lte', value: 6 }], visibility: { actors: ['wilson'], clues: [] }, performers: ['wilson'] },
    { type: 'fact', id: 'red-haired-office', text: '红发会的工作时间是上午十点到下午两点，离开办公室就会失去职位。', knownBy: ['wilson'] },
    { type: 'clue', id: 'mud-on-floor', name: '地面上的新鲜泥痕', location: 'basement', detail: '泥痕和膝部磨损的方向显示，这里有人反复向银行一侧挖掘。', discoveredBy: [] },
    { type: 'memory', actorId: 'wilson', text: '红发会在1890年10月9日突然解散。' },
    { type: 'memory', actorId: 'clay', text: '地下空间的准备必须继续，但不能让威尔逊看见。' },
    { type: 'memory', actorId: 'holmes', text: '典当铺后方连接着银行，现场痕迹比传闻更可靠。' },
  ]);
  definition.world.title = '红发会：庞大的阴影';
  definition.world.description = '伦敦萨克斯·科堡广场的一间当铺，隔着墙就是一座银行。';
  definition.world.environment.weather = '伦敦阴冷的秋日，雾气贴着街面';
  definition.scene.title = '萨克斯·科堡广场 · 案件现场';
  definition.scene.style = { palette: 'victorian-archive', voxelUnit: 0.58, seed: 1661 };
  const roomByPlace = new Map(definition.world.places.map(place => [place.id, place.roomId]));
  const rooms = new Map(definition.scene.objects.filter(object => object.kind === 'room').map(room => [room.id, room]));
  const tuneRoom = (placeId, position, bounds, rotation = 0) => {
    const room = rooms.get(roomByPlace.get(placeId));
    if (!room) return;
    room.bounds = { ...room.bounds, ...bounds };
    room.transform = { ...room.transform, position: [...position], rotation };
  };
  const placePosition = new Map([
    ['pawnshop', [-5, 0.8, 0]],
    ['basement', [-5, 0.8, 8]],
    ['bank', [5, 0.8, 0]],
  ]);
  for (const place of definition.world.places) place.position = [...placePosition.get(place.id)];
  definition.scene.regions.find(region => region.kind === 'island').radius = 15.5;
  tuneRoom('pawnshop', [-5, 0, 0], { width: 8.8, depth: 6.4, wallHeight: 3.35, floor: 0.8 }, -0.06);
  tuneRoom('basement', [-5, 0, 8], { width: 7.3, depth: 7.8, wallHeight: 2.65, floor: 0.8 }, 0.1);
  tuneRoom('bank', [5, 0, 0], { width: 8.1, depth: 6.7, wallHeight: 3.45, floor: 0.8 }, -0.12);
  for (const character of definition.scene.objects.filter(object => object.kind === 'character')) {
    const actor = definition.world.actors.find(entry => entry.id === character.id);
    character.position = [...placePosition.get(actor.location)];
  }
  return definition;
}
