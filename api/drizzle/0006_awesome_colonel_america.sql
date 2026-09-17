CREATE TABLE `persona_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`sender_person_id` text NOT NULL,
	`recipient_person_id` text NOT NULL,
	`content` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`sim_time` text NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action
);
