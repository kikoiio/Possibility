CREATE TABLE `user_world_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`space_id` text DEFAULT 'exterior' NOT NULL,
	`mode` text DEFAULT 'life' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `user_world_preferences_world` ON `user_world_preferences` (`world_id`);
