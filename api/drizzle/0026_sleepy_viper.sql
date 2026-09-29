ALTER TABLE `memories` ADD `mentioned_person_ids_json` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `location_name` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `topics_json` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `memories_person_timeline_created` ON `memories` (`person_id`,`timeline_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `memories_person_timeline_importance` ON `memories` (`person_id`,`timeline_id`,`importance`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `memory_access` (
	`memory_id` text PRIMARY KEY NOT NULL,
	`last_accessed_sim_at` text NOT NULL,
	`access_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
