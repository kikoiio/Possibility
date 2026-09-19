CREATE TABLE `commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`person_id` text NOT NULL,
	`visitor_id` text NOT NULL,
	`source_dialogue_id` text,
	`title` text NOT NULL,
	`kind` text DEFAULT 'meeting' NOT NULL,
	`location` text NOT NULL,
	`due_sim` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_sim` text NOT NULL,
	`updated_sim` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`visitor_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scene_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`dialogue_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dialogue_id`) REFERENCES `dialogues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `world_visits` (
	`user_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`event_cursor` integer DEFAULT 0 NOT NULL,
	`seen_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `timeline_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `dialogues` ADD `kind` text DEFAULT 'npc' NOT NULL;--> statement-breakpoint
ALTER TABLE `dialogues` ADD `visitor_id` text REFERENCES persons(id);--> statement-breakpoint
ALTER TABLE `dialogues` ADD `scene_busy_until` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `scene_session_scope` ON `dialogues` (`timeline_id`,`visitor_id`,`location`);--> statement-breakpoint
ALTER TABLE `timelines` ADD `fork_snapshot_json` text;