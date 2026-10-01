-- S4 世界模拟:体素事件蒸馏投影表(WorldEvent + sourceEventIds 证据链;created_version 水位同 0029 纪律)
CREATE TABLE `voxel_event_projections` (
	`id` text PRIMARY KEY NOT NULL,
	`timeline_id` text NOT NULL REFERENCES `timelines`(`id`),
	`payload_json` text NOT NULL,
	`created_version` integer
);
--> statement-breakpoint
CREATE INDEX `voxel_event_projections_timeline_created_version` ON `voxel_event_projections` (`timeline_id`, `created_version`);
