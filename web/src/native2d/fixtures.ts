/**
 * N2D1 T04：雾影庄固定世界状态。
 *
 * 提供确定性的 WorldReadModel 快照，供固定来源（T07 world-source 固定分支）、
 * 单元测试与浏览器夹具消费。全部数据为固定字面量：
 * - 不使用 Date.now / Math.random，simNow 均为固定 ISO 字符串；
 * - worldId / timelineId / personId / fixtureId / scope 全部稳定；
 * - 地点名与 api/src/dev/seed-demo.ts 的真实雾影庄地点一致，
 *   以便 T06 场景绑定（大厅、后山散步道等）直接对上。
 *
 * 只导入 ./types 的类型；不导入 PixiJS、API 客户端或存储。
 */

import type {
  SampleScope,
  WorldLocation,
  WorldReadModel,
  WorldResident,
} from './types'

/** 场景身份与 T06 场景定义对齐。 */
export const FIXTURE_SCENE_ID = 'mist-manor'
export const FIXTURE_SCENE_VERSION = 1

export const FIXTURE_WORLD_NAME = '雾影庄'
export const FIXTURE_TIME_ZONE = 'Asia/Tokyo'

/**
 * 主固定范围：fixture 来源，快照刷新（day/night/refresh/overcrowded/unknown-time）
 * 共用此 scope，保证刷新用例固定同一世界与时间线。
 */
export const FIXTURE_SCOPE: SampleScope = {
  source: 'fixture',
  worldId: 'fixture-world-mist-manor',
  timelineId: 'fixture-timeline-mist-manor-001',
  sceneId: FIXTURE_SCENE_ID,
  sceneVersion: FIXTURE_SCENE_VERSION,
}

/**
 * 第二组确定范围：public 来源、不同 worldId/timelineId，
 * 用于验证来源/世界/时间线隔离（布局存储与读取固定互不串扰）。
 */
export const PUBLIC_DEMO_SCOPE: SampleScope = {
  source: 'public',
  worldId: 'demo-world-mist-manor',
  timelineId: 'demo-timeline-mist-manor-001',
  sceneId: FIXTURE_SCENE_ID,
  sceneVersion: FIXTURE_SCENE_VERSION,
}

/** 与 seed-demo 人物卡对应的稳定 personId。 */
export const FIXTURE_PERSON_IDS = {
  muginoToru: 'person-mugino-toru',
  shirakawaSoichiro: 'person-shirakawa-soichiro',
  sayo: 'person-sayo',
  hiiragiKazunari: 'person-hiiragi-kazunari',
  shirakawaRei: 'person-shirakawa-rei',
  mitamuraChizuru: 'person-mitamura-chizuru',
} as const

/** 与 seed-demo 一致的真实地点名（T06 sourceLocationName 以此为绑定键）。 */
export const FIXTURE_LOCATION_NAMES = {
  hall: '大厅',
  study: '书房',
  diningRoom: '餐厅',
  library: '图书室',
  greenhouse: '温室花房',
  gatehouse: '门房小屋',
  backHillTrail: '后山散步道',
} as const

function fixtureLocations(): WorldLocation[] {
  return [
    {
      name: FIXTURE_LOCATION_NAMES.hall,
      description: '雾影庄的迎客厅，暖炉与挂钟，住客们最常碰面的地方。',
    },
    {
      name: FIXTURE_LOCATION_NAMES.study,
      description: '庄主白川宗一郎的房间，书架与账桌，未经许可不得入内——窗边的视线很好。',
    },
    {
      name: FIXTURE_LOCATION_NAMES.diningRoom,
      description: '长桌八席，一日三餐与饭桌上的闲谈在此。',
    },
    {
      name: FIXTURE_LOCATION_NAMES.library,
      description: '收藏旧书与旧报纸的安静房间，角落堆着多年未动的库房箱子。',
    },
    {
      name: FIXTURE_LOCATION_NAMES.greenhouse,
      description: '玻璃顶的暖房，宗一郎的兰草与时令花草，雾气在玻璃上结露。',
    },
    {
      name: FIXTURE_LOCATION_NAMES.gatehouse,
      description: '庄门旁的小木屋，现借给记者三田村千鹤居住。',
    },
    {
      name: FIXTURE_LOCATION_NAMES.backHillTrail,
      description: '通往温泉的山径，穿过杉木林，往返约半个时辰。',
    },
  ]
}

/**
 * 白昼基准快照居民：覆盖大厅（多人）、后山散步道、未提供内景的书房、
 * 未知地点（locationName null）与未知活动（activity null）。
 */
function dayResidents(): WorldResident[] {
  return [
    {
      personId: FIXTURE_PERSON_IDS.muginoToru,
      name: '雾野 透',
      locationName: FIXTURE_LOCATION_NAMES.hall,
      activity: '在暖炉边翻看侦探笔记',
    },
    {
      personId: FIXTURE_PERSON_IDS.shirakawaSoichiro,
      name: '白川 宗一郎',
      locationName: FIXTURE_LOCATION_NAMES.study,
      activity: '在账桌前整理旧账册',
    },
    {
      personId: FIXTURE_PERSON_IDS.sayo,
      name: '小夜',
      locationName: FIXTURE_LOCATION_NAMES.hall,
      activity: '为住客们准备热茶',
    },
    {
      personId: FIXTURE_PERSON_IDS.hiiragiKazunari,
      name: '柊 一成',
      locationName: null,
      activity: null,
    },
    {
      personId: FIXTURE_PERSON_IDS.shirakawaRei,
      name: '白川 怜',
      locationName: FIXTURE_LOCATION_NAMES.backHillTrail,
      activity: '沿山径独自散步',
    },
    {
      personId: FIXTURE_PERSON_IDS.mitamuraChizuru,
      name: '三田村 千鹤',
      locationName: FIXTURE_LOCATION_NAMES.gatehouse,
      activity: '整理采访笔记',
    },
  ]
}

export const FIXTURE_IDS = [
  'mist-manor-day',
  'mist-manor-night',
  'mist-manor-refresh',
  'mist-manor-overcrowded',
  'mist-manor-unknown-time',
  'public-mist-manor-day',
] as const

export type FixtureId = (typeof FIXTURE_IDS)[number]

const FIXTURE_BUILDERS: Record<FixtureId, () => WorldReadModel> = {
  /**
   * 昼：13:00 JST（09–17 昼段）。基准身份与地点覆盖快照。
   */
  'mist-manor-day': () => ({
    scope: FIXTURE_SCOPE,
    worldName: FIXTURE_WORLD_NAME,
    simNow: '2026-01-15T04:00:00.000Z',
    timeZone: FIXTURE_TIME_ZONE,
    stateVersion: 101,
    locations: fixtureLocations(),
    residents: dayResidents(),
  }),

  /**
   * 夜：23:00 JST（20–06 夜段）。同一批居民，作息位置不同。
   */
  'mist-manor-night': () => ({
    scope: FIXTURE_SCOPE,
    worldName: FIXTURE_WORLD_NAME,
    simNow: '2026-01-15T14:00:00.000Z',
    timeZone: FIXTURE_TIME_ZONE,
    stateVersion: 102,
    locations: fixtureLocations(),
    residents: [
      {
        personId: FIXTURE_PERSON_IDS.muginoToru,
        name: '雾野 透',
        locationName: FIXTURE_LOCATION_NAMES.library,
        activity: '在旧报纸堆里翻查三十年前的记录',
      },
      {
        personId: FIXTURE_PERSON_IDS.shirakawaSoichiro,
        name: '白川 宗一郎',
        locationName: FIXTURE_LOCATION_NAMES.study,
        activity: '独自坐在书房炉火边',
      },
      {
        personId: FIXTURE_PERSON_IDS.sayo,
        name: '小夜',
        locationName: FIXTURE_LOCATION_NAMES.hall,
        activity: null,
      },
      {
        personId: FIXTURE_PERSON_IDS.hiiragiKazunari,
        name: '柊 一成',
        locationName: null,
        activity: null,
      },
      {
        personId: FIXTURE_PERSON_IDS.shirakawaRei,
        name: '白川 怜',
        locationName: FIXTURE_LOCATION_NAMES.hall,
        activity: '对着挂钟出神',
      },
      {
        personId: FIXTURE_PERSON_IDS.mitamuraChizuru,
        name: '三田村 千鹤',
        locationName: FIXTURE_LOCATION_NAMES.gatehouse,
        activity: '核对失踪案的采访时间线',
      },
    ],
  }),

  /**
   * 刷新后快照：同一 scope（同一 worldId/timelineId），stateVersion 前进，
   * 多名居民地点发生变化，且柊一成（person-hiiragi-kazunari）从快照中消失。
   */
  'mist-manor-refresh': () => ({
    scope: FIXTURE_SCOPE,
    worldName: FIXTURE_WORLD_NAME,
    simNow: '2026-01-15T05:30:00.000Z',
    timeZone: FIXTURE_TIME_ZONE,
    stateVersion: 103,
    locations: fixtureLocations(),
    residents: [
      {
        personId: FIXTURE_PERSON_IDS.muginoToru,
        name: '雾野 透',
        locationName: FIXTURE_LOCATION_NAMES.backHillTrail,
        activity: '沿山径走向温泉方向',
      },
      {
        personId: FIXTURE_PERSON_IDS.shirakawaSoichiro,
        name: '白川 宗一郎',
        locationName: FIXTURE_LOCATION_NAMES.greenhouse,
        activity: '侍弄兰草',
      },
      {
        personId: FIXTURE_PERSON_IDS.sayo,
        name: '小夜',
        locationName: FIXTURE_LOCATION_NAMES.diningRoom,
        activity: '收拾午餐的长桌',
      },
      {
        personId: FIXTURE_PERSON_IDS.shirakawaRei,
        name: '白川 怜',
        locationName: FIXTURE_LOCATION_NAMES.hall,
        activity: '声称在构思小说情节',
      },
      {
        personId: FIXTURE_PERSON_IDS.mitamuraChizuru,
        name: '三田村 千鹤',
        locationName: FIXTURE_LOCATION_NAMES.hall,
        activity: '与住客闲聊打探消息',
      },
    ],
  }),

  /**
   * 站位不足：全部六名居民同时在大厅，人数多于大厅示意站位。
   * T18 须保留真实归属并对放不下的居民返回定位限制。
   */
  'mist-manor-overcrowded': () => ({
    scope: FIXTURE_SCOPE,
    worldName: FIXTURE_WORLD_NAME,
    simNow: '2026-01-15T10:00:00.000Z',
    timeZone: FIXTURE_TIME_ZONE,
    stateVersion: 104,
    locations: fixtureLocations(),
    residents: [
      {
        personId: FIXTURE_PERSON_IDS.muginoToru,
        name: '雾野 透',
        locationName: FIXTURE_LOCATION_NAMES.hall,
        activity: '向大家出示那封无落款信件',
      },
      {
        personId: FIXTURE_PERSON_IDS.shirakawaSoichiro,
        name: '白川 宗一郎',
        locationName: FIXTURE_LOCATION_NAMES.hall,
        activity: '召集全员说明晚餐安排',
      },
      {
        personId: FIXTURE_PERSON_IDS.sayo,
        name: '小夜',
        locationName: FIXTURE_LOCATION_NAMES.hall,
        activity: '为全员添茶',
      },
      {
        personId: FIXTURE_PERSON_IDS.hiiragiKazunari,
        name: '柊 一成',
        locationName: FIXTURE_LOCATION_NAMES.hall,
        activity: '不动声色地观察每个人',
      },
      {
        personId: FIXTURE_PERSON_IDS.shirakawaRei,
        name: '白川 怜',
        locationName: FIXTURE_LOCATION_NAMES.hall,
        activity: '靠在墙边听众人谈话',
      },
      {
        personId: FIXTURE_PERSON_IDS.mitamuraChizuru,
        name: '三田村 千鹤',
        locationName: FIXTURE_LOCATION_NAMES.hall,
        activity: '飞快记录每个人的反应',
      },
    ],
  }),

  /**
   * 未知时间输入：simNow 为 null。表现层须把时间标为 unknown，
   * 不套用任何昼夜相位。
   */
  'mist-manor-unknown-time': () => ({
    scope: FIXTURE_SCOPE,
    worldName: FIXTURE_WORLD_NAME,
    simNow: null,
    timeZone: FIXTURE_TIME_ZONE,
    stateVersion: 105,
    locations: fixtureLocations(),
    residents: dayResidents(),
  }),

  /**
   * 第二组 scope：public 来源、不同 worldId/timelineId 的白昼快照，
   * 与主固定范围共享场景但身份完全隔离。
   */
  'public-mist-manor-day': () => ({
    scope: PUBLIC_DEMO_SCOPE,
    worldName: FIXTURE_WORLD_NAME,
    simNow: '2026-01-15T04:00:00.000Z',
    timeZone: FIXTURE_TIME_ZONE,
    stateVersion: 7,
    locations: fixtureLocations(),
    residents: dayResidents(),
  }),
}

/**
 * 按 fixtureId 取固定快照。每次调用都构造全新对象与数组，
 * 调用方对返回值的任何（违规）修改都不会污染后续读取。
 */
export function createFixtureReadModel(fixtureId: FixtureId): WorldReadModel {
  const builder = FIXTURE_BUILDERS[fixtureId]
  if (!builder) {
    throw new Error(`未知的 native2d fixture：${String(fixtureId)}`)
  }
  return builder()
}
