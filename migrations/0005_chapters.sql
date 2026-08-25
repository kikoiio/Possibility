-- 章节表：周期性把一段条目浓缩为章节概要（前情提要，累积即成故事概览）
CREATE TABLE chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- 生成时刻
  title TEXT NOT NULL,            -- 章节标题
  content TEXT NOT NULL,          -- 章节概要
  from_ts INTEGER NOT NULL,       -- 覆盖条目的时间起点
  to_ts INTEGER NOT NULL          -- 覆盖条目的时间终点
);

-- usage_records 重建：purpose 枚举扩展 narrate（叙事段落）/ chapter（章节总结）
CREATE TABLE usage_records_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('plan','action','dialogue','monologue','reflection','mystery','guard','narrate','chapter')),
  tier TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  est_cost REAL NOT NULL
);
INSERT INTO usage_records_new SELECT * FROM usage_records;
DROP TABLE usage_records;
ALTER TABLE usage_records_new RENAME TO usage_records;
CREATE INDEX idx_usage_ts ON usage_records (ts);
