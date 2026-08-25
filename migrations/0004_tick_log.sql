-- 心跳日志：每次 tick 留一行（成功/失败），监测程序据此判断世界是否真停了
CREATE TABLE tick_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,               -- tick 开始时刻
  slept INTEGER NOT NULL,            -- 是否休眠跳过
  entries_published INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT                         -- 失败时的错误信息（成功为 NULL）
);
CREATE INDEX idx_tick_log_ts ON tick_log (ts DESC);
