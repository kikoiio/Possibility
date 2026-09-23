CREATE TABLE `universe_revisions` (
	`timeline_id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`world_model_version` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `world_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`expected_version` integer NOT NULL,
	`result_version` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `world_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`timeline_id` text NOT NULL,
	`version` integer NOT NULL,
	`sim_time` text NOT NULL,
	`fact_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`value_json` text NOT NULL,
	`source_command_id` text NOT NULL,
	`visibility` text DEFAULT 'world' NOT NULL,
	`supersedes_id` text,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_command_id`) REFERENCES `world_commands`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `world_facts_timeline_version` ON `world_facts` (`timeline_id`,`version`);--> statement-breakpoint
CREATE TABLE `world_model_versions` (
	`world_id` text NOT NULL,
	`version` integer NOT NULL,
	`model_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`world_id`, `version`),
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TRIGGER `world_facts_revision_guard` BEFORE INSERT ON `world_facts`
BEGIN
	SELECT CASE WHEN COALESCE((SELECT `version` FROM `universe_revisions` WHERE `timeline_id` = NEW.`timeline_id`), -1) <> NEW.`version`
		THEN RAISE(ABORT, 'world_state_version_conflict') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `world_commands` WHERE `id` = NEW.`source_command_id`
		AND `timeline_id` = NEW.`timeline_id` AND `result_version` = NEW.`version`
	) THEN RAISE(ABORT, 'world_state_command_mismatch') END;
	SELECT CASE WHEN (SELECT `sim_now` FROM `timelines` WHERE `id` = NEW.`timeline_id`) <> NEW.`sim_time`
		THEN RAISE(ABORT, 'world_state_time_conflict') END;
	SELECT CASE WHEN NEW.`fact_type` = 'commitment' AND NOT EXISTS (
		SELECT 1 FROM `commitments` WHERE `id` = NEW.`subject_id`
		AND `timeline_id` = NEW.`timeline_id`
		AND `status` = json_extract(NEW.`value_json`, '$.to')
	) THEN RAISE(ABORT, 'world_state_commitment_projection_conflict') END;
END;
--> statement-breakpoint
CREATE TRIGGER `world_commands_scope_guard` BEFORE INSERT ON `world_commands`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `timelines` t JOIN `worlds` w ON w.`id` = t.`world_id`
		WHERE t.`id` = NEW.`timeline_id` AND t.`world_id` = NEW.`world_id`
		AND t.`status` = 'active' AND w.`status` = 'running'
	) THEN RAISE(ABORT, 'world_state_scope_or_status_conflict') END;
END;
--> statement-breakpoint
CREATE TRIGGER `fork_source_revision_guard` BEFORE INSERT ON `timelines`
WHEN NEW.`parent_timeline_id` IS NOT NULL AND NEW.`fork_snapshot_json` IS NOT NULL
  AND json_type(NEW.`fork_snapshot_json`, '$.sourceStateVersion') = 'integer'
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `timelines` t JOIN `worlds` w ON w.`id` = t.`world_id`
		WHERE t.`id` = NEW.`parent_timeline_id` AND t.`world_id` = NEW.`world_id`
		AND t.`status` = 'active' AND w.`status` = 'running'
	) THEN RAISE(ABORT, 'fork_source_scope_or_status_conflict') END;
	SELECT CASE WHEN (
		SELECT COUNT(*) FROM `timelines` WHERE `world_id` = NEW.`world_id` AND `status` = 'active'
	) >= 3 THEN RAISE(ABORT, 'fork_active_limit_conflict') END;
	SELECT CASE WHEN COALESCE((SELECT `version` FROM `universe_revisions` WHERE `timeline_id` = NEW.`parent_timeline_id`), -1)
		<> json_extract(NEW.`fork_snapshot_json`, '$.sourceStateVersion')
		THEN RAISE(ABORT, 'fork_source_version_conflict') END;
	SELECT CASE WHEN (SELECT `sim_now` FROM `timelines` WHERE `id` = NEW.`parent_timeline_id`)
		<> json_extract(NEW.`fork_snapshot_json`, '$.sourceSimTime')
		THEN RAISE(ABORT, 'fork_source_time_conflict') END;
	SELECT CASE WHEN (
		SELECT COUNT(*) FROM `person_states` WHERE `timeline_id` = NEW.`parent_timeline_id`
	) <> json_array_length(NEW.`fork_snapshot_json`, '$.states') OR EXISTS (
		SELECT 1 FROM json_each(NEW.`fork_snapshot_json`, '$.states') s
		LEFT JOIN `person_states` p ON p.`timeline_id` = NEW.`parent_timeline_id`
			AND p.`person_id` = json_extract(s.value, '$.personId')
		WHERE p.`person_id` IS NULL
			OR p.`location` IS NOT json_extract(s.value, '$.location')
			OR p.`activity` IS NOT json_extract(s.value, '$.activity')
			OR p.`mood` IS NOT json_extract(s.value, '$.mood')
			OR p.`goal` IS NOT json_extract(s.value, '$.goal')
			OR p.`current_dialogue_id` IS NOT json_extract(s.value, '$.currentDialogueId')
			OR p.`sim_time` IS NOT json_extract(s.value, '$.simTime')
	) THEN RAISE(ABORT, 'fork_source_state_conflict') END;
END;
