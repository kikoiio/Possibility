PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_worlds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`locations_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'paused' NOT NULL,
	`pause_reason` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`calls_today` integer DEFAULT 0 NOT NULL,
	`calls_day` text,
	`created_at` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_worlds`("id", "user_id", "name", "description", "locations_json", "status", "pause_reason", "is_demo", "calls_today", "calls_day", "created_at") SELECT "id", "user_id", "name", "description", "locations_json", "status", "pause_reason", "is_demo", "calls_today", "calls_day", "created_at" FROM `worlds`;--> statement-breakpoint
DROP TABLE `worlds`;--> statement-breakpoint
ALTER TABLE `__new_worlds` RENAME TO `worlds`;