CREATE TABLE `provenance_response_snapshots` (
  `response_id` text PRIMARY KEY NOT NULL,
  `chat_request_id` text NOT NULL UNIQUE REFERENCES `chat_requests`(`request_id`),
  `conversation_id` text NOT NULL REFERENCES `conversations`(`id`),
  `world_id` text NOT NULL REFERENCES `worlds`(`id`),
  `timeline_id` text NOT NULL REFERENCES `timelines`(`id`),
  `resident_id` text NOT NULL REFERENCES `persons`(`id`),
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `question` text NOT NULL,
  `question_hash` text NOT NULL,
  `snapshot_id` text NOT NULL,
  `schema_version` integer NOT NULL DEFAULT 1,
  `snapshot_json` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `provenance_response_snapshot_scope` ON `provenance_response_snapshots` (`world_id`,`timeline_id`,`resident_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `provenance_response_attempts` (
  `attempt_id` text PRIMARY KEY NOT NULL,
  `response_id` text NOT NULL REFERENCES `provenance_response_snapshots`(`response_id`),
  `status` text NOT NULL DEFAULT 'pending',
  `stage` text NOT NULL DEFAULT 'reading',
  `output_json` text,
  `error_code` text,
  `lease_token` text,
  `lease_generation` integer NOT NULL DEFAULT 0,
  `lease_expires_at` text,
  `created_at` text NOT NULL,
  `finished_at` text
);
--> statement-breakpoint
CREATE INDEX `provenance_response_attempt_response` ON `provenance_response_attempts` (`response_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `provenance_repair_runs` (
  `run_id` text PRIMARY KEY NOT NULL,
  `scope_hash` text NOT NULL UNIQUE,
  `world_id` text NOT NULL REFERENCES `worlds`(`id`),
  `timeline_id` text NOT NULL REFERENCES `timelines`(`id`),
  `resident_id` text NOT NULL REFERENCES `persons`(`id`),
  `rule_version` text NOT NULL,
  `scope_json` text NOT NULL,
  `frozen_bounds_json` text NOT NULL,
  `cursor_json` text,
  `status` text NOT NULL DEFAULT 'pending',
  `batch_size` integer NOT NULL DEFAULT 20,
  `scanned` integer NOT NULL DEFAULT 0,
  `linked` integer NOT NULL DEFAULT 0,
  `already_valid` integer NOT NULL DEFAULT 0,
  `insufficient_evidence` integer NOT NULL DEFAULT 0,
  `conflicting_evidence` integer NOT NULL DEFAULT 0,
  `last_error` text,
  `lease_token` text,
  `lease_generation` integer NOT NULL DEFAULT 0,
  `lease_expires_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `provenance_repair_run_status` ON `provenance_repair_runs` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `provenance_repair_items` (
  `item_id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL REFERENCES `provenance_repair_runs`(`run_id`),
  `record_kind` text NOT NULL,
  `record_id` text NOT NULL,
  `origin_timeline_id` text NOT NULL,
  `original_digest` text NOT NULL,
  `original_excerpt` text NOT NULL,
  `status` text NOT NULL,
  `source_refs_json` text NOT NULL DEFAULT '[]',
  `link_ids_json` text NOT NULL DEFAULT '[]',
  `reason` text NOT NULL,
  `committed_sequence` integer NOT NULL,
  `created_at` text NOT NULL,
  UNIQUE (`run_id`,`record_kind`,`record_id`)
);
--> statement-breakpoint
CREATE INDEX `provenance_repair_item_sequence` ON `provenance_repair_items` (`run_id`,`committed_sequence`);
--> statement-breakpoint
CREATE TABLE `provenance_source_links` (
  `link_id` text PRIMARY KEY NOT NULL,
  `world_id` text NOT NULL REFERENCES `worlds`(`id`),
  `timeline_id` text NOT NULL REFERENCES `timelines`(`id`),
  `resident_id` text NOT NULL REFERENCES `persons`(`id`),
  `record_kind` text NOT NULL,
  `record_id` text NOT NULL,
  `source_kind` text NOT NULL,
  `source_id` text NOT NULL,
  `source_timeline_id` text NOT NULL,
  `relation` text NOT NULL,
  `rule_version` text NOT NULL,
  `original_digest` text NOT NULL,
  `source_digest` text NOT NULL,
  `repair_item_id` text REFERENCES `provenance_repair_items`(`item_id`),
  `created_at` text NOT NULL,
  UNIQUE (`world_id`,`timeline_id`,`resident_id`,`record_kind`,`record_id`,`source_kind`,`source_id`,`relation`,`rule_version`)
);
--> statement-breakpoint
CREATE INDEX `provenance_source_link_target` ON `provenance_source_links` (`world_id`,`timeline_id`,`resident_id`,`record_kind`,`record_id`);
