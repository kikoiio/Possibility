ALTER TABLE `world_commands`
  ADD `clone_source_command_id` text REFERENCES `world_commands`(`id`);
--> statement-breakpoint
ALTER TABLE `world_facts`
  ADD `clone_source_fact_id` text REFERENCES `world_facts`(`id`);
--> statement-breakpoint
DROP TRIGGER `world_facts_revision_guard`;
--> statement-breakpoint
CREATE TRIGGER `world_facts_revision_guard` BEFORE INSERT ON `world_facts`
BEGIN
	SELECT CASE WHEN COALESCE((SELECT `version` FROM `universe_revisions` WHERE `timeline_id` = NEW.`timeline_id`), -1) <> NEW.`version`
		AND NOT EXISTS (
			SELECT 1
			FROM `world_facts` source_fact
			JOIN `world_commands` target_command ON target_command.`id` = NEW.`source_command_id`
			JOIN `world_commands` source_command ON source_command.`id` = target_command.`clone_source_command_id`
			JOIN `timelines` target_timeline ON target_timeline.`id` = NEW.`timeline_id`
			WHERE source_fact.`id` = NEW.`clone_source_fact_id`
				AND source_fact.`source_command_id` = source_command.`id`
				AND target_command.`clone_source_command_id` = source_fact.`source_command_id`
				AND source_fact.`version` = NEW.`version`
				AND source_fact.`sim_time` = NEW.`sim_time`
				AND source_fact.`fact_type` = NEW.`fact_type`
				AND source_fact.`value_json` = NEW.`value_json`
				AND source_fact.`visibility` = NEW.`visibility`
				AND target_command.`world_id` = target_timeline.`world_id`
				AND target_command.`world_id` <> source_command.`world_id`
				AND target_command.`result_version` = NEW.`version`
		)
		THEN RAISE(ABORT, 'world_state_version_conflict') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `world_commands` WHERE `id` = NEW.`source_command_id`
		AND `timeline_id` = NEW.`timeline_id` AND `result_version` = NEW.`version`
	) THEN RAISE(ABORT, 'world_state_command_mismatch') END;
	SELECT CASE WHEN (SELECT `sim_time` FROM `universe_revisions` WHERE `timeline_id` = NEW.`timeline_id`) IS NOT NEW.`sim_time`
		AND NOT EXISTS (
			SELECT 1
			FROM `world_facts` source_fact
			JOIN `world_commands` target_command ON target_command.`id` = NEW.`source_command_id`
			JOIN `world_commands` source_command ON source_command.`id` = target_command.`clone_source_command_id`
			JOIN `timelines` target_timeline ON target_timeline.`id` = NEW.`timeline_id`
			WHERE source_fact.`id` = NEW.`clone_source_fact_id`
				AND source_fact.`source_command_id` = source_command.`id`
				AND target_command.`clone_source_command_id` = source_fact.`source_command_id`
				AND source_fact.`version` = NEW.`version`
				AND source_fact.`sim_time` = NEW.`sim_time`
				AND source_fact.`fact_type` = NEW.`fact_type`
				AND source_fact.`value_json` = NEW.`value_json`
				AND source_fact.`visibility` = NEW.`visibility`
				AND target_command.`world_id` = target_timeline.`world_id`
				AND target_command.`world_id` <> source_command.`world_id`
				AND target_command.`result_version` = NEW.`version`
		)
		THEN RAISE(ABORT, 'world_state_time_conflict') END;
	SELECT CASE WHEN NEW.`fact_type` = 'commitment' AND NOT EXISTS (
		SELECT 1 FROM `commitments` WHERE `id` = NEW.`subject_id`
		AND `timeline_id` = NEW.`timeline_id`
		AND `status` = json_extract(NEW.`value_json`, '$.to')
	) THEN RAISE(ABORT, 'world_state_commitment_projection_conflict') END;
END;
--> statement-breakpoint
DROP TRIGGER `world_facts_revision_time_guard`;
--> statement-breakpoint
CREATE TRIGGER `world_facts_revision_time_guard` BEFORE INSERT ON `world_facts`
BEGIN
	SELECT CASE WHEN COALESCE((SELECT `sim_time` FROM `universe_revisions` WHERE `timeline_id` = NEW.`timeline_id`), '') <> NEW.`sim_time`
		AND NOT EXISTS (
			SELECT 1
			FROM `world_facts` source_fact
			JOIN `world_commands` target_command ON target_command.`id` = NEW.`source_command_id`
			JOIN `world_commands` source_command ON source_command.`id` = target_command.`clone_source_command_id`
			JOIN `timelines` target_timeline ON target_timeline.`id` = NEW.`timeline_id`
			WHERE source_fact.`id` = NEW.`clone_source_fact_id`
				AND source_fact.`source_command_id` = source_command.`id`
				AND target_command.`clone_source_command_id` = source_fact.`source_command_id`
				AND source_fact.`version` = NEW.`version`
				AND source_fact.`sim_time` = NEW.`sim_time`
				AND source_fact.`fact_type` = NEW.`fact_type`
				AND source_fact.`value_json` = NEW.`value_json`
				AND source_fact.`visibility` = NEW.`visibility`
				AND target_command.`world_id` = target_timeline.`world_id`
				AND target_command.`world_id` <> source_command.`world_id`
				AND target_command.`result_version` = NEW.`version`
		)
		THEN RAISE(ABORT, 'world_state_revision_time_conflict') END;
END;
