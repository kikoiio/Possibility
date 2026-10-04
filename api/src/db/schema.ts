import { sqliteTable, text, integer, primaryKey, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  createdAt: text('created_at').notNull(),
})

export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  expiresAt: text('expires_at').notNull(),
})

export const persons = sqliteTable('persons', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  modelJson: text('model_json').notNull(),
  // true = 用户在世界里的"在场身份"（由用户亲自扮演；引擎不为 TA 排日程/节拍/对话）
  isUser: integer('is_user', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
})

export const worlds = sqliteTable('worlds', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  description: text('description').notNull(),
  // [{name, description}]，5-8 个地点；旧数据迁移时回填默认地点
  locationsJson: text('locations_json').notNull().default('[]'),
  // running / paused / capped（触顶自动暂停）
  status: text('status').notNull().default('paused'),
  // manual / daily_cap / global_daily_cap / null
  pauseReason: text('pause_reason'),
  isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
  callsToday: integer('calls_today').notNull().default(0),
  // 用户级 BYOK 覆盖:{ baseUrl?, apiKey?, model? },逐字段覆盖全局配置;null = 跟随全局
  llmConfigJson: text('llm_config_json'),
  // callsToday 对应的真实日期（YYYY-MM-DD），换天自动清零
  callsDay: text('calls_day'),
  // 最近一次用户交互（聊天/注入/章节等）；闲置自动归档以此为据（null = 不归档）
  lastUserActivityAt: text('last_user_activity_at'),
  // IANA time zone; null is legacy data interpreted as UTC
  timeZone: text('time_zone'),
  createdAt: text('created_at').notNull().default(''),
})

/** Visual layout lives beside a world and never creates universe evidence/revisions. */
export const worldScenes = sqliteTable('world_scenes', {
  worldId: text('world_id').primaryKey().references(() => worlds.id),
  currentVersion: integer('current_version').notNull(),
  themeId: text('theme_id').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const worldSceneRevisions = sqliteTable('world_scene_revisions', {
  id: text('id').primaryKey(),
  worldId: text('world_id').notNull().references(() => worlds.id),
  version: integer('version').notNull(),
  parentVersion: integer('parent_version'),
  requestId: text('request_id').notNull(),
  contentHash: text('content_hash').notNull(),
  documentJson: text('document_json').notNull(),
  summary: text('summary').notNull(),
  kind: text('kind').notNull(),
  createdAt: text('created_at').notNull(),
}, t => [uniqueIndex('world_scene_revision_version').on(t.worldId, t.version), uniqueIndex('world_scene_revision_request').on(t.worldId, t.requestId), index('world_scene_revision_history').on(t.worldId, t.version)])

/** Cross-Worker single-flight guard for the autonomous engine tick. */
export const engineTickLeases = sqliteTable('engine_tick_leases', {
  id: text('id').primaryKey(),
  ownerToken: text('owner_token').notNull(),
  leaseUntil: integer('lease_until').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** 人物 ↔ 世界 多对多；状态/记忆挂在（person × timeline）上天然按世界隔离 */
export const worldPersons = sqliteTable(
  'world_persons',
  {
    worldId: text('world_id')
      .notNull()
      .references(() => worlds.id),
    personId: text('person_id')
      .notNull()
      .references(() => persons.id),
    joinedAt: text('joined_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.personId] })],
)

export const timelines = sqliteTable('timelines', {
  id: text('id').primaryKey(),
  worldId: text('world_id')
    .notNull()
    .references(() => worlds.id),
  // null = 主线
  parentTimelineId: text('parent_timeline_id'),
  forkScenarioJson: text('fork_scenario_json'),
  simNow: text('sim_now').notNull(),
  createdAt: text('created_at').notNull(),
  // active / archived（引擎只推 active）
  status: text('status').notNull().default('active'),
  // 从主线到自己的祖先链 [mainId, forkId1, ...]，主线为 []
  ancestorIdsJson: text('ancestor_ids_json').notNull().default('[]'),
  // 上次引擎推进此线的真实时间（时钟推进依据）
  lastRealTickAt: text('last_real_tick_at'),
  forkSnapshotJson: text('fork_snapshot_json'),
})

/** Child-timeline memories written before the resident-safe prompt cutover require review. */
export const residentMemorySafety = sqliteTable('resident_memory_safety', {
  timelineId: text('timeline_id').primaryKey().references(() => timelines.id),
  safeAfterCreatedAt: text('safe_after_created_at').notNull(),
  createdAt: text('created_at').notNull(),
})

export const residentMemoryRepairRuns = sqliteTable('resident_memory_repair_runs', {
  id: text('id').primaryKey(),
  worldId: text('world_id').notNull().references(() => worlds.id),
  timelineId: text('timeline_id').notNull().references(() => timelines.id),
  personId: text('person_id').notNull().references(() => persons.id),
  status: text('status').notNull().default('pending'),
  cursorCreatedAt: text('cursor_created_at'),
  cursorMemoryId: text('cursor_memory_id'),
  batchSize: integer('batch_size').notNull(),
  scanned: integer('scanned').notNull().default(0),
  rebuilt: integer('rebuilt').notNull().default(0),
  unreconstructable: integer('unreconstructable').notNull().default(0),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, t => [
  uniqueIndex('resident_memory_repair_scope').on(t.worldId, t.timelineId, t.personId),
  index('resident_memory_repair_status').on(t.status, t.updatedAt),
])

export const residentMemoryRepairItems = sqliteTable('resident_memory_repair_items', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => residentMemoryRepairRuns.id),
  sourceMemoryId: text('source_memory_id').notNull().references(() => memories.id),
  status: text('status').notNull(),
  replacementMemoryId: text('replacement_memory_id').references(() => memories.id),
  sourceIdsJson: text('source_ids_json').notNull().default('[]'),
  reason: text('reason'),
  createdAt: text('created_at').notNull(),
}, t => [uniqueIndex('resident_memory_repair_source').on(t.runId, t.sourceMemoryId)])

/** ForkSnapshot 正文外置存储(0028):timelines.forkSnapshotJson 只留 $ref 指针;旧行内 v1 永久可读 */
export const forkSnapshots = sqliteTable('fork_snapshots', {
  timelineId: text('timeline_id')
    .primaryKey()
    .references(() => timelines.id),
  // 与 ForkSnapshot.version 对齐(现=1)
  version: integer('version').notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: text('created_at').notNull(),
})

/** 日界核心锚点(0029, S4/F6):每线每世界日一份可变核心快照,历史分叉重建的封顶基点 */
export const timelineAnchors = sqliteTable('timeline_anchors', {
  timelineId: text('timeline_id')
    .notNull()
    .references(() => timelines.id),
  // 锚点 simTime 的世界日(YYYY-MM-DD)
  simDay: text('sim_day').notNull(),
  // 捕获时的宇宙版本水位
  version: integer('version').notNull(),
  simTime: text('sim_time').notNull(),
  worldModelVersion: integer('world_model_version').notNull(),
  // AnchorCorePayload 规范哈希(SHA-256)
  coreHash: text('core_hash').notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.timelineId, t.simDay] })])

/** 用户级 BYOK 全局 LLM 配置与日预算(0028);行不存在 = 未配置(预算缺省 400) */
export const userLlmConfigs = sqliteTable('user_llm_configs', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  baseUrl: text('base_url'),
  apiKey: text('api_key'),
  model: text('model'),
  // null = 不限;行不存在时按代码缺省 400
  dailyCallCap: integer('daily_call_cap'),
  verificationFingerprint: text('verification_fingerprint'),
  verifiedAt: text('verified_at'),
  updatedAt: text('updated_at').notNull(),
})

/** Audited replay evidence for one Universe timeline. Non-complete rows are fail-closed. */
export const universeEvidence = sqliteTable(
  'universe_evidence',
  {
    timelineId: text('timeline_id')
      .primaryKey()
      .references(() => timelines.id),
    level: text('level').notNull().default('unassessed'),
    assessedVersion: integer('assessed_version'),
    baselineVersion: integer('baseline_version'),
    reasonCodesJson: text('reason_codes_json').notNull().default('[]'),
    assessedAt: text('assessed_at').notNull(),
  },
  (t) => [index('universe_evidence_level').on(t.level)],
)

export const personStates = sqliteTable(
  'person_states',
  {
    personId: text('person_id')
      .notNull()
      .references(() => persons.id),
    timelineId: text('timeline_id')
      .notNull()
      .references(() => timelines.id),
    simTime: text('sim_time').notNull(),
    location: text('location').notNull(),
    activity: text('activity').notNull(),
    mood: text('mood').notNull(),
    goal: text('goal').notNull(),
    updatedRealAt: text('updated_real_at').notNull(),
    // 正在进行的对话 id，非空时引擎跳过此人的节拍
    currentDialogueId: text('current_dialogue_id'),
    // 上次生活节拍的虚拟时间（注入事件感知的水位线）
    lastBeatSimTime: text('last_beat_sim_time'),
  },
  (t) => [primaryKey({ columns: [t.personId, t.timelineId] })],
)

/** 每人每线每个世界日一份当日日程 */
export const schedules = sqliteTable(
  'schedules',
  {
    personId: text('person_id')
      .notNull()
      .references(() => persons.id),
    timelineId: text('timeline_id')
      .notNull()
      .references(() => timelines.id),
    // 世界日（simNow 的日期部分，YYYY-MM-DD）
    worldDate: text('world_date').notNull(),
    // [{start, end, location, activity, kind?}]
    itemsJson: text('items_json').notNull(),
    generatedAt: text('generated_at').notNull(),
    // S4 版本水位：写入时的宇宙修订版本；NULL = 部署前旧行
    createdVersion: integer('created_version'),
  },
  (t) => [primaryKey({ columns: [t.personId, t.timelineId, t.worldDate] })],
)

export const dialogues = sqliteTable('dialogues', {
  id: text('id').primaryKey(),
  timelineId: text('timeline_id')
    .notNull()
    .references(() => timelines.id),
  location: text('location').notNull(),
  // [personId, ...]，2-3 人
  participantIdsJson: text('participant_ids_json').notNull(),
  // ongoing / ended
  status: text('status').notNull().default('ongoing'),
  turnLimit: integer('turn_limit').notNull().default(8),
  simStart: text('sim_start').notNull(),
  simEnd: text('sim_end'),
  kind: text('kind').notNull().default('npc'),
  visitorId: text('visitor_id').references(() => persons.id),
  sceneBusyUntil: integer('scene_busy_until'),
  createdVersion: integer('created_version'),
}, t => [uniqueIndex('scene_session_scope').on(t.timelineId, t.visitorId, t.location)])

export const sceneRequests = sqliteTable('scene_requests', {
  id: text('id').primaryKey(),
  dialogueId: text('dialogue_id').notNull().references(() => dialogues.id),
  contentHash: text('content_hash').notNull().default(''),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  heartbeatAt: integer('heartbeat_at').notNull().default(0),
})

/** Server-side pending natural-language proposals, recoverable across browser sessions. */
export const sceneIntentProposals = sqliteTable('scene_intent_proposals', {
  requestId: text('request_id').primaryKey(),
  worldId: text('world_id').notNull().references(() => worlds.id),
  timelineId: text('timeline_id').notNull().references(() => timelines.id),
  userId: text('user_id').notNull().references(() => users.id),
  personId: text('person_id').notNull().references(() => persons.id),
  content: text('content').notNull(),
  resolutionJson: text('resolution_json').notNull(),
  expectedVersion: integer('expected_version').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
})

export const dialogueTurns = sqliteTable('dialogue_turns', {
  id: text('id').primaryKey(),
  dialogueId: text('dialogue_id')
    .notNull()
    .references(() => dialogues.id),
  turnIndex: integer('turn_index').notNull(),
  personId: text('person_id')
    .notNull()
    .references(() => persons.id),
  utterance: text('utterance').notNull(),
  // 同一次生成产出的内心想法（同步写记忆流 type=thought）
  thought: text('thought').notNull(),
  simTime: text('sim_time').notNull(),
  createdAt: text('created_at').notNull(),
  createdVersion: integer('created_version'),
})

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  personId: text('person_id')
    .notNull()
    .references(() => persons.id),
  // null = 主线
  timelineId: text('timeline_id'),
  // source / world / timeline / relationship / thought / summary
  type: text('type').notNull(),
  content: text('content').notNull(),
  simTime: text('sim_time'),
  createdAt: text('created_at').notNull(),
  // 1-10，写入时由 LLM 顺带评分；迁移旧数据默认 5
  importance: integer('importance').notNull().default(5),
  // 已被某条 summary 压缩覆盖（不再进提示词，库中保留可回溯）
  summarized: integer('summarized', { mode: 'boolean' }).notNull().default(false),
  // S1 情境标注（契约 v2 起随记忆写入；NULL = 旧数据/无标注）
  mentionedPersonIdsJson: text('mentioned_person_ids_json'),
  locationName: text('location_name'),
  topicsJson: text('topics_json'),
  // S2 摘要层级（NULL = 原文；1 = L1 由原文压出；2 = L2 由 L1 压出，封顶）
  level: integer('level'),
  createdVersion: integer('created_version'),
}, t => [
  index('memories_person_timeline_created').on(t.personId, t.timelineId, t.createdAt),
  index('memories_person_timeline_importance').on(t.personId, t.timelineId, t.importance, t.createdAt),
])

// 排练簿记（S1）：非世界状态——memories 行由命令日志投影重建，
// 非命令派生列会在重建时丢失，故排练元数据独立成表
export const memoryAccess = sqliteTable('memory_access', {
  memoryId: text('memory_id')
    .primaryKey()
    .references(() => memories.id),
  lastAccessedSimAt: text('last_accessed_sim_at').notNull(),
  accessCount: integer('access_count').notNull().default(0),
})

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  timelineId: text('timeline_id')
    .notNull()
    .references(() => timelines.id),
  simTime: text('sim_time').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  // action / dialogue / injected / system
  kind: text('kind').notNull().default('action'),
  // 行动者（injected / system 可为空）
  actorPersonId: text('actor_person_id'),
  // kind=dialogue 时关联 dialogues.id
  dialogueId: text('dialogue_id'),
  createdVersion: integer('created_version'),
})

/** S4 世界模拟:life 事件蒸馏出的体素事件投影(WorldEvent + sourceEventIds 证据链)。
 * 派生数据——可随时由蒸馏管线重建;created_version 水位纪律同 0029,供历史分叉回放过滤。 */
export const voxelEventProjections = sqliteTable('voxel_event_projections', {
  // vep:{timelineId}:{clusterKey}
  id: text('id').primaryKey(),
  timelineId: text('timeline_id')
    .notNull()
    .references(() => timelines.id),
  // { event: WorldEvent, sourceEventIds: string[], copySource: 'template' | 'llm' }
  payloadJson: text('payload_json').notNull(),
  createdVersion: integer('created_version'),
}, t => [
  index('voxel_event_projections_timeline_created_version').on(t.timelineId, t.createdVersion),
])

/** 成本护栏与可观测性：每次 LLM 调用一行；世界创建前的调用（蒸馏/骨架）记 user_id、world_id 为空 */
export const llmCallLog = sqliteTable('llm_call_log', {
  id: text('id').primaryKey(),
  requestId: text('request_id'),
  worldId: text('world_id'),
  userId: text('user_id'),
  timelineId: text('timeline_id'),
  personId: text('person_id'),
  // schedule / beat / dialogue_turn / injection / summary / chat / distill / voxel_distill / world_draft / fork_preview / fork_simulate / chapter / director / scene
  purpose: text('purpose').notNull(),
  contextHash: text('context_hash'),
  contractVersion: text('contract_version'),
  apiKeySource: text('api_key_source'),
  budgetBucket: text('budget_bucket'),
  // Existing rows predate receipts and keep null as an explicit unknown legacy outcome.
  status: text('status'),
  errorCode: text('error_code'),
  // 真实时间（每日上限按真实日期统计）
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
})

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    personId: text('person_id')
      .notNull()
      .references(() => persons.id),
    timelineId: text('timeline_id')
      .notNull()
      .references(() => timelines.id),
  },
  (t) => [uniqueIndex('conversations_person_timeline').on(t.personId, t.timelineId)],
)

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id),
  // user / person / system_note
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
})

/** Durable idempotency/recovery state for ordinary chat SSE requests across devices. */
export const chatRequests = sqliteTable('chat_requests', {
  requestId: text('request_id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  userId: text('user_id').notNull().references(() => users.id),
  worldId: text('world_id').notNull().references(() => worlds.id),
  timelineId: text('timeline_id').notNull().references(() => timelines.id),
  personId: text('person_id').notNull().references(() => persons.id),
  contentHash: text('content_hash').notNull(),
  userMessageId: text('user_message_id').notNull().references(() => messages.id),
  replyMessageId: text('reply_message_id').notNull(),
  status: text('status').notNull().default('pending'),
  heartbeatAt: integer('heartbeat_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  finishedAt: text('finished_at'),
  errorCode: text('error_code'),
})

/** 章节：时间线事件流的小说化回顾（驻场叙事者一次 LLM 调用生成，可反复阅读） */
export const chapters = sqliteTable('chapters', {
  id: text('id').primaryKey(),
  worldId: text('world_id')
    .notNull()
    .references(() => worlds.id),
  timelineId: text('timeline_id')
    .notNull()
    .references(() => timelines.id),
  title: text('title').notNull(),
  content: text('content').notNull(),
  // 本章覆盖的虚拟时间区间 [fromSim, toSim]
  fromSim: text('from_sim').notNull(),
  toSim: text('to_sim').notNull(),
  eventCount: integer('event_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
})

/** 留给在场身份（用户）的留言：scene 中人物主动托付/邀约/提醒，进入世界时送达 */
export const personaMessages = sqliteTable('persona_messages', {
  id: text('id').primaryKey(),
  worldId: text('world_id')
    .notNull()
    .references(() => worlds.id),
  timelineId: text('timeline_id')
    .notNull()
    .references(() => timelines.id),
  senderPersonId: text('sender_person_id')
    .notNull()
    .references(() => persons.id),
  recipientPersonId: text('recipient_person_id')
    .notNull()
    .references(() => persons.id),
  content: text('content').notNull(),
  // 留言发生地点（“在温室花房留下话”）
  location: text('location').notNull().default(''),
  simTime: text('sim_time').notNull(),
  read: integer('read', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  createdVersion: integer('created_version'),
})

/** 可执行的约定。proposed 仅是邀请，用户接受后才构成承诺。 */
export const commitments = sqliteTable('commitments', {
  id: text('id').primaryKey(),
  worldId: text('world_id').notNull().references(() => worlds.id),
  timelineId: text('timeline_id').notNull().references(() => timelines.id),
  personId: text('person_id').notNull().references(() => persons.id),
  visitorId: text('visitor_id').notNull().references(() => persons.id),
  sourceDialogueId: text('source_dialogue_id'),
  title: text('title').notNull(),
  kind: text('kind').notNull().default('meeting'),
  location: text('location').notNull(),
  dueSim: text('due_sim').notNull(),
  status: text('status').notNull().default('proposed'),
  createdSim: text('created_sim').notNull(),
  updatedSim: text('updated_sim').notNull(),
  createdAt: text('created_at').notNull(),
})

/** 已看过的事件水位按用户与时间线隔离，GET 不改变水位。 */
export const worldVisits = sqliteTable('world_visits', {
  userId: text('user_id').notNull().references(() => users.id),
  timelineId: text('timeline_id').notNull().references(() => timelines.id),
  eventCursor: integer('event_cursor').notNull().default(0),
  seenAt: text('seen_at').notNull(),
}, t => [primaryKey({ columns: [t.userId, t.timelineId] })])

/** A frozen world definition. Existing worlds receive their first version on first state access. */
export const worldModelVersions = sqliteTable('world_model_versions', {
  worldId: text('world_id').notNull().references(() => worlds.id),
  version: integer('version').notNull(),
  modelJson: text('model_json').notNull(),
  createdAt: text('created_at').notNull(),
}, t => [primaryKey({ columns: [t.worldId, t.version] })])

/** Each timeline is currently the concrete Universe identity. */
export const universeRevisions = sqliteTable('universe_revisions', {
  timelineId: text('timeline_id').primaryKey().references(() => timelines.id),
  version: integer('version').notNull().default(0),
  simTime: text('sim_time').notNull(),
  worldModelVersion: integer('world_model_version').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** Accepted command and its idempotency result; rejected commands do not enter world history. */
export const worldCommands = sqliteTable('world_commands', {
  id: text('id').primaryKey(),
  worldId: text('world_id').notNull().references(() => worlds.id),
  timelineId: text('timeline_id').notNull().references(() => timelines.id),
  actorKind: text('actor_kind').notNull(),
  actorId: text('actor_id'),
  type: text('type').notNull(),
  payloadJson: text('payload_json').notNull(),
  expectedVersion: integer('expected_version').notNull(),
  resultVersion: integer('result_version').notNull(),
  // Non-null only for commands issued by the autonomous tick; DB trigger fences stale Workers.
  tickLeaseToken: text('tick_lease_token'),
  createdAt: text('created_at').notNull(),
})

/** One immutable primary fact per accepted command. Corrections append a new fact. */
export const worldFacts = sqliteTable('world_facts', {
  id: text('id').primaryKey(),
  timelineId: text('timeline_id').notNull().references(() => timelines.id),
  version: integer('version').notNull(),
  simTime: text('sim_time').notNull(),
  factType: text('fact_type').notNull(),
  subjectId: text('subject_id').notNull(),
  valueJson: text('value_json').notNull(),
  sourceCommandId: text('source_command_id').notNull().references(() => worldCommands.id),
  visibility: text('visibility').notNull().default('world'),
  supersedesId: text('supersedes_id'),
}, t => [uniqueIndex('world_facts_timeline_version').on(t.timelineId, t.version)])

/** Last map context per account; it contains navigation state, never world facts. */
export const userWorldPreferences = sqliteTable('user_world_preferences', {
  userId: text('user_id').primaryKey().references(() => users.id),
  worldId: text('world_id').notNull().references(() => worlds.id),
  timelineId: text('timeline_id').notNull().references(() => timelines.id),
  spaceId: text('space_id').notNull().default('exterior'),
  mode: text('mode').notNull().default('life'),
  updatedAt: text('updated_at').notNull(),
}, t => [index('user_world_preferences_world').on(t.worldId)])

/** Immutable public demo roots. Only one row may be active at a time. */
export const demoBaselines = sqliteTable('demo_baselines', {
  id: text('id').primaryKey(),
  worldId: text('world_id').notNull().references(() => worlds.id),
  sceneVersion: integer('scene_version').notNull(),
  contentHash: text('content_hash').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: text('created_at').notNull(),
  retiredAt: text('retired_at'),
}, t => [
  uniqueIndex('demo_baselines_world').on(t.worldId),
  index('demo_baselines_status').on(t.status),
])

/** Browser-held guest credentials. The raw token is never persisted. */
export const guestSessions = sqliteTable('guest_sessions', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  currentSandboxWorldId: text('current_sandbox_world_id').references(() => worlds.id),
  generation: integer('generation').notNull().default(0),
  status: text('status').notNull().default('active'),
  resumeTimelineId: text('resume_timeline_id').references(() => timelines.id),
  resumeSpaceId: text('resume_space_id').notNull().default('exterior'),
  resumeMode: text('resume_mode').notNull().default('life'),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, t => [
  uniqueIndex('guest_sessions_token_hash').on(t.tokenHash),
  uniqueIndex('guest_sessions_owner').on(t.ownerUserId),
  uniqueIndex('guest_sessions_current_sandbox').on(t.currentSandboxWorldId),
  index('guest_sessions_status_expiry').on(t.status, t.expiresAt),
])

/** Every reset creates a new generation and preserves an auditable predecessor. */
export const demoSandboxes = sqliteTable('demo_sandboxes', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => guestSessions.id),
  baselineId: text('baseline_id').notNull().references(() => demoBaselines.id),
  worldId: text('world_id').notNull().references(() => worlds.id),
  generation: integer('generation').notNull(),
  status: text('status').notNull().default('active'),
  requestId: text('request_id').notNull(),
  claimedWorldId: text('claimed_world_id').references(() => worlds.id),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, t => [
  uniqueIndex('demo_sandboxes_world').on(t.worldId),
  uniqueIndex('demo_sandboxes_generation').on(t.sessionId, t.generation),
  uniqueIndex('demo_sandboxes_request').on(t.sessionId, t.requestId),
  index('demo_sandboxes_session_status').on(t.sessionId, t.status),
  index('demo_sandboxes_status_expiry').on(t.status, t.expiresAt),
])
