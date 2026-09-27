CREATE TABLE `world_scene_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`version` integer NOT NULL,
	`parent_version` integer,
	`request_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`document_json` text NOT NULL,
	`summary` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `world_scene_revision_version` ON `world_scene_revisions` (`world_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `world_scene_revision_request` ON `world_scene_revisions` (`world_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `world_scene_revision_history` ON `world_scene_revisions` (`world_id`,`version`);--> statement-breakpoint
CREATE TABLE `world_scenes` (
	`world_id` text PRIMARY KEY NOT NULL,
	`current_version` integer NOT NULL,
	`theme_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action
);
