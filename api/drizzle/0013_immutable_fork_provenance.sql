CREATE TRIGGER `fork_provenance_immutable_update` BEFORE UPDATE OF `parent_timeline_id`, `fork_scenario_json`, `fork_snapshot_json`, `ancestor_ids_json` ON `timelines`
WHEN OLD.`parent_timeline_id` IS NOT NEW.`parent_timeline_id`
	OR OLD.`fork_scenario_json` IS NOT NEW.`fork_scenario_json`
	OR OLD.`fork_snapshot_json` IS NOT NEW.`fork_snapshot_json`
	OR OLD.`ancestor_ids_json` IS NOT NEW.`ancestor_ids_json`
BEGIN
	SELECT CASE WHEN OLD.`parent_timeline_id` IS NOT NULL OR NEW.`parent_timeline_id` IS NOT NULL
		OR OLD.`fork_snapshot_json` IS NOT NULL OR NEW.`fork_snapshot_json` IS NOT NULL
		OR OLD.`ancestor_ids_json` IS NOT NULL OR NEW.`ancestor_ids_json` IS NOT NULL
		THEN RAISE(ABORT, 'fork_provenance_immutable') END;
END;
