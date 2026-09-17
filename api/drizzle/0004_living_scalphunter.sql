CREATE TABLE `chapters` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`from_sim` text NOT NULL,
	`to_sim` text NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
