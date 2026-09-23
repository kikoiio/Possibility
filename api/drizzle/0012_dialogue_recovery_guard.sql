CREATE TRIGGER `world_dialogue_recovery_precondition` BEFORE INSERT ON `world_commands`
WHEN NEW.`type` = 'dialogue_recovery'
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `person_states`
		WHERE `timeline_id` = NEW.`timeline_id`
			AND `person_id` = json_extract(NEW.`payload_json`, '$.personId')
			AND `current_dialogue_id` = json_extract(NEW.`payload_json`, '$.dialogueId')
	) THEN RAISE(ABORT, 'dialogue_recovery_stale') END;
	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM `dialogues`
		WHERE `timeline_id` = NEW.`timeline_id`
			AND `id` = json_extract(NEW.`payload_json`, '$.dialogueId')
			AND `status` = 'ongoing'
	) THEN RAISE(ABORT, 'dialogue_recovery_active') END;
END;
