ALTER TABLE `persons` ADD `is_user` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `worlds` ADD `last_user_activity_at` text;