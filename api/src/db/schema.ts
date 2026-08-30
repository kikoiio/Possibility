import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
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
  // manual / daily_cap / null
  pauseReason: text('pause_reason'),
  isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
  callsToday: integer('calls_today').notNull().default(0),
  // callsToday 对应的真实日期（YYYY-MM-DD），换天自动清零
  callsDay: text('calls_day'),
  createdAt: text('created_at').notNull().default(''),
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
})

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
})

/** 成本护栏与可观测性：每次 LLM 调用一行 */
export const llmCallLog = sqliteTable('llm_call_log', {
  id: text('id').primaryKey(),
  worldId: text('world_id')
    .notNull()
    .references(() => worlds.id),
  timelineId: text('timeline_id'),
  personId: text('person_id'),
  // schedule / beat / dialogue_turn / injection / summary / chat / distill
  purpose: text('purpose').notNull(),
  // 真实时间（每日上限按真实日期统计）
  createdAt: text('created_at').notNull(),
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
