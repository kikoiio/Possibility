ALTER TABLE user_llm_configs ADD COLUMN verification_fingerprint TEXT;
--> statement-breakpoint
ALTER TABLE user_llm_configs ADD COLUMN verified_at TEXT;
--> statement-breakpoint
ALTER TABLE llm_call_log ADD COLUMN api_key_source TEXT;
--> statement-breakpoint
ALTER TABLE llm_call_log ADD COLUMN budget_bucket TEXT;
