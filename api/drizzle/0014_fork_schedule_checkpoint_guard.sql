CREATE TRIGGER `fork_source_schedule_guard` BEFORE INSERT ON `timelines`
WHEN NEW.`parent_timeline_id` IS NOT NULL AND NEW.`fork_snapshot_json` IS NOT NULL
	AND json_type(NEW.`fork_snapshot_json`, '$.sourceStateVersion') = 'integer'
BEGIN
	SELECT CASE WHEN (
		SELECT COUNT(*) FROM `schedules`
		WHERE `timeline_id` = NEW.`parent_timeline_id`
			AND `world_date` >= substr(json_extract(NEW.`fork_snapshot_json`, '$.sourceSimTime'), 1, 10)
	) <> json_array_length(NEW.`fork_snapshot_json`, '$.schedules') THEN RAISE(ABORT, 'fork_source_schedule_conflict') END;
	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM json_each(NEW.`fork_snapshot_json`, '$.schedules') snapshot
		WHERE NOT EXISTS (
			SELECT 1 FROM `schedules` source
			WHERE source.`timeline_id` = NEW.`parent_timeline_id`
				AND source.`world_date` >= substr(json_extract(NEW.`fork_snapshot_json`, '$.sourceSimTime'), 1, 10)
				AND source.`person_id` = json_extract(snapshot.value, '$.personId')
				AND source.`world_date` = json_extract(snapshot.value, '$.worldDate')
				AND source.`items_json` = json_extract(snapshot.value, '$.itemsJson')
				AND source.`generated_at` = json_extract(snapshot.value, '$.generatedAt')
		)
	) OR EXISTS (
		SELECT 1 FROM `schedules` source
		WHERE source.`timeline_id` = NEW.`parent_timeline_id`
			AND source.`world_date` >= substr(json_extract(NEW.`fork_snapshot_json`, '$.sourceSimTime'), 1, 10)
			AND NOT EXISTS (
				SELECT 1 FROM json_each(NEW.`fork_snapshot_json`, '$.schedules') snapshot
				WHERE json_extract(snapshot.value, '$.personId') = source.`person_id`
					AND json_extract(snapshot.value, '$.worldDate') = source.`world_date`
					AND json_extract(snapshot.value, '$.itemsJson') = source.`items_json`
					AND json_extract(snapshot.value, '$.generatedAt') = source.`generated_at`
			)
	) THEN RAISE(ABORT, 'fork_source_schedule_conflict') END;
END;
