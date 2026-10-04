CREATE TABLE `resident_memory_safety` (
  `timeline_id` text PRIMARY KEY NOT NULL REFERENCES `timelines`(`id`),
  `safe_after_created_at` text NOT NULL,
  `created_at` text NOT NULL
);

-- Existing child-line memories were generated before resident-safe prompts. Keep them out of
-- retrieval and compression; post-cutover memories become eligible through the safe prompt path.
INSERT INTO `resident_memory_safety` (`timeline_id`, `safe_after_created_at`, `created_at`)
SELECT `id`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `timelines`
WHERE `parent_timeline_id` IS NOT NULL;

CREATE TABLE `resident_memory_repair_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `world_id` text NOT NULL REFERENCES `worlds`(`id`),
  `timeline_id` text NOT NULL REFERENCES `timelines`(`id`),
  `person_id` text NOT NULL REFERENCES `persons`(`id`),
  `status` text DEFAULT 'pending' NOT NULL,
  `cursor_created_at` text,
  `cursor_memory_id` text,
  `batch_size` integer NOT NULL,
  `scanned` integer DEFAULT 0 NOT NULL,
  `rebuilt` integer DEFAULT 0 NOT NULL,
  `unreconstructable` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `resident_memory_repair_status` ON `resident_memory_repair_runs` (`status`, `updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `resident_memory_repair_scope` ON `resident_memory_repair_runs` (`world_id`, `timeline_id`, `person_id`);
--> statement-breakpoint
CREATE TABLE `resident_memory_repair_items` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL REFERENCES `resident_memory_repair_runs`(`id`),
  `source_memory_id` text NOT NULL REFERENCES `memories`(`id`),
  `status` text NOT NULL,
  `replacement_memory_id` text REFERENCES `memories`(`id`),
  `source_ids_json` text DEFAULT '[]' NOT NULL,
  `reason` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resident_memory_repair_source` ON `resident_memory_repair_items` (`run_id`, `source_memory_id`);
