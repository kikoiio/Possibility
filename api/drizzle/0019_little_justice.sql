CREATE TABLE `scene_intent_proposals` (
	`request_id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`user_id` text NOT NULL,
	`person_id` text NOT NULL,
	`content` text NOT NULL,
	`resolution_json` text NOT NULL,
	`expected_version` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action
);
