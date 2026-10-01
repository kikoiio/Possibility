CREATE TABLE `fork_snapshots` (
	`timeline_id` text PRIMARY KEY NOT NULL REFERENCES `timelines`(`id`),
	`version` integer NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_llm_configs` (
	`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`),
	`base_url` text,
	`api_key` text,
	`model` text,
	`daily_call_cap` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `worlds` ADD `llm_config_json` text;
