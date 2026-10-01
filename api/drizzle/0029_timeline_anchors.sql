-- S4/F6 历史 checkpoint:每线每世界日一份核心锚点(可变核心+版本水位+完整性哈希)
CREATE TABLE `timeline_anchors` (
	`timeline_id` text NOT NULL REFERENCES `timelines`(`id`),
	`sim_day` text NOT NULL,
	`version` integer NOT NULL,
	`sim_time` text NOT NULL,
	`world_model_version` integer NOT NULL,
	`core_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`timeline_id`, `sim_day`)
);
--> statement-breakpoint
-- 版本水位列:历史重建以 created_version ≤ V 精确过滤(simTime 存在倒日期行,不足以区分版本前后)
ALTER TABLE `events` ADD `created_version` integer;
--> statement-breakpoint
ALTER TABLE `memories` ADD `created_version` integer;
--> statement-breakpoint
ALTER TABLE `dialogues` ADD `created_version` integer;
--> statement-breakpoint
ALTER TABLE `dialogue_turns` ADD `created_version` integer;
--> statement-breakpoint
ALTER TABLE `persona_messages` ADD `created_version` integer;
--> statement-breakpoint
ALTER TABLE `schedules` ADD `created_version` integer;
--> statement-breakpoint
CREATE INDEX `events_timeline_created_version` ON `events` (`timeline_id`, `created_version`);
--> statement-breakpoint
CREATE INDEX `memories_timeline_created_version` ON `memories` (`timeline_id`, `created_version`);
