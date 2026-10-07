CREATE TABLE `native2d_layout_heads` (
	`world_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`scene_id` text NOT NULL,
	`current_revision_id` text NOT NULL,
	`current_version` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`world_id`, `timeline_id`, `scene_id`),
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `native2d_layout_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`scene_id` text NOT NULL,
	`version` integer NOT NULL,
	`parent_version` integer,
	`request_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`layout_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `native2d_layout_revision_version` ON `native2d_layout_revisions` (`world_id`,`timeline_id`,`scene_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `native2d_layout_revision_request` ON `native2d_layout_revisions` (`world_id`,`timeline_id`,`scene_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `native2d_layout_revision_history` ON `native2d_layout_revisions` (`world_id`,`timeline_id`,`scene_id`,`version`);