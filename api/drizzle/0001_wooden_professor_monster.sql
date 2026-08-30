CREATE TABLE `dialogue_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`dialogue_id` text NOT NULL,
	`turn_index` integer NOT NULL,
	`person_id` text NOT NULL,
	`utterance` text NOT NULL,
	`thought` text NOT NULL,
	`sim_time` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`dialogue_id`) REFERENCES `dialogues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dialogues` (
	`id` text PRIMARY KEY NOT NULL,
	`timeline_id` text NOT NULL,
	`location` text NOT NULL,
	`participant_ids_json` text NOT NULL,
	`status` text DEFAULT 'ongoing' NOT NULL,
	`turn_limit` integer DEFAULT 8 NOT NULL,
	`sim_start` text NOT NULL,
	`sim_end` text,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `llm_call_log` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`timeline_id` text,
	`person_id` text,
	`purpose` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`person_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`world_date` text NOT NULL,
	`items_json` text NOT NULL,
	`generated_at` text NOT NULL,
	PRIMARY KEY(`person_id`, `timeline_id`, `world_date`),
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `world_persons` (
	`world_id` text NOT NULL,
	`person_id` text NOT NULL,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`world_id`, `person_id`),
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `events` ADD `kind` text DEFAULT 'action' NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `actor_person_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `dialogue_id` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `importance` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `summarized` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `person_states` ADD `current_dialogue_id` text;--> statement-breakpoint
ALTER TABLE `person_states` ADD `last_beat_sim_time` text;--> statement-breakpoint
ALTER TABLE `timelines` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `timelines` ADD `ancestor_ids_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `timelines` ADD `last_real_tick_at` text;--> statement-breakpoint
ALTER TABLE `worlds` ADD `locations_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `worlds` ADD `status` text DEFAULT 'paused' NOT NULL;--> statement-breakpoint
ALTER TABLE `worlds` ADD `pause_reason` text;--> statement-breakpoint
ALTER TABLE `worlds` ADD `is_demo` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `worlds` ADD `calls_today` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `worlds` ADD `calls_day` text;--> statement-breakpoint
ALTER TABLE `worlds` ADD `created_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- ===== 手工回填（T1 步骤 5；须在 0002 删除 worlds.person_id 之前执行） =====
-- world_persons ← 旧 worlds 的单人物归属
INSERT INTO `world_persons` (`world_id`, `person_id`, `joined_at`)
  SELECT `id`, `person_id`, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM `worlds`;--> statement-breakpoint
-- 阶段一分叉均为一级分叉（父=主线），祖先链 = [父线 id]
UPDATE `timelines` SET `ancestor_ids_json` = json_array(`parent_timeline_id`) WHERE `parent_timeline_id` IS NOT NULL;--> statement-breakpoint
-- 注入事件感知水位线初始化到当前状态时刻
UPDATE `person_states` SET `last_beat_sim_time` = `sim_time` WHERE `last_beat_sim_time` IS NULL;--> statement-breakpoint
-- 旧事件归属到该世界的人物（kind 已由列默认值填 'action'）
UPDATE `events` SET `actor_person_id` = (
  SELECT w.`person_id` FROM `timelines` t JOIN `worlds` w ON w.`id` = t.`world_id`
  WHERE t.`id` = `events`.`timeline_id`
);--> statement-breakpoint
-- worlds.createdAt 回填当前时间
UPDATE `worlds` SET `created_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE `created_at` = '';
