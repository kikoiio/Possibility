PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_llm_call_log` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text,
	`user_id` text,
	`timeline_id` text,
	`person_id` text,
	`purpose` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_llm_call_log`("id", "world_id", "user_id", "timeline_id", "person_id", "purpose", "created_at") SELECT "id", "world_id", "user_id", "timeline_id", "person_id", "purpose", "created_at" FROM `llm_call_log`;--> statement-breakpoint
DROP TABLE `llm_call_log`;--> statement-breakpoint
ALTER TABLE `__new_llm_call_log` RENAME TO `llm_call_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;