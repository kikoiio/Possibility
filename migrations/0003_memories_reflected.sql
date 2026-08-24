-- 反思机制：标记已参与过反思的记忆（maybeReflect 的"未反思显著度累计"依据）
ALTER TABLE memories ADD COLUMN reflected INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_memories_unreflected ON memories (resident_id, reflected, salience);
