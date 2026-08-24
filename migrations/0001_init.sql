-- 虚拟邻居 D1 初始 schema
-- 注意：FTS5 虚拟表必须用小写 fts5（大写会报 not authorized）

-- 信息流条目
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('activity','dialogue','monologue','mystery')),
  resident_ids TEXT NOT NULL,          -- JSON array of resident ids
  location TEXT NOT NULL,
  title TEXT,                          -- mystery 类条目标题
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','taken_down'))
);
CREATE INDEX idx_entries_ts ON entries (ts DESC);
CREATE INDEX idx_entries_status ON entries (status);

-- 居民记忆（FTS5 外部内容表，rowid 关联）
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resident_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('observation','event','dialogue','reflection','plan')),
  content TEXT NOT NULL,
  salience INTEGER NOT NULL CHECK (salience BETWEEN 1 AND 5),
  tags TEXT NOT NULL DEFAULT '',       -- 空格分隔关键词
  subject TEXT                         -- 关于谁：居民/背景人物/未来访客 id
);
CREATE INDEX idx_memories_resident_ts ON memories (resident_id, ts DESC);
CREATE INDEX idx_memories_kind ON memories (kind);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  tags,
  content='memories',
  content_rowid='id'
);

-- FTS 同步触发器
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, content, tags)
  VALUES (new.id, new.content, new.tags);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, content, tags)
  VALUES ('delete', old.id, old.content, old.tags);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, content, tags)
  VALUES ('delete', old.id, old.content, old.tags);
  INSERT INTO memories_fts (rowid, content, tags)
  VALUES (new.id, new.content, new.tags);
END;

-- 谜团
CREATE TABLE mysteries (
  id TEXT PRIMARY KEY,
  arc TEXT NOT NULL CHECK (arc IN ('daily','seasonal')),
  title TEXT NOT NULL,
  premise TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'spawned' CHECK (state IN ('spawned','investigating','resolved')),
  clues TEXT NOT NULL DEFAULT '[]',    -- JSON array of {ts, text}
  resolution TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);

-- LLM 用量
CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('plan','action','dialogue','monologue','reflection','mystery','guard')),
  tier TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  est_cost REAL NOT NULL
);
CREATE INDEX idx_usage_ts ON usage_records (ts);

-- 护栏与管理操作记录
CREATE TABLE moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  target_type TEXT NOT NULL,           -- 'entry' | 'profile' | 'admin_action'
  target_id TEXT,                      -- entry id / profile id / null
  action TEXT NOT NULL,                -- 'blocked' | 'taken_down'
  reason TEXT NOT NULL
);

-- 世界状态快照（单行）
CREATE TABLE world_snapshots (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ts INTEGER NOT NULL,
  state TEXT NOT NULL                  -- JSON
);
