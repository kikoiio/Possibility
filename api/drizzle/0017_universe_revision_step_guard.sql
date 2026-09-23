-- Universe heads may advance only one version at a time and only for a command
-- that was inserted in the same transaction batch.
CREATE TRIGGER `universe_revision_step_guard` BEFORE UPDATE OF `version` ON `universe_revisions`
BEGIN
	SELECT CASE WHEN NEW.`version` <> OLD.`version` + 1
		THEN RAISE(ABORT, 'universe_revision_must_advance_by_one') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `world_commands`
		WHERE `timeline_id` = NEW.`timeline_id`
			AND `expected_version` = OLD.`version`
			AND `result_version` = NEW.`version`
	) THEN RAISE(ABORT, 'universe_revision_requires_command') END;
END;
