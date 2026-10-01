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
