CREATE TRIGGER `active_timeline_limit_insert` BEFORE INSERT ON `timelines`
WHEN NEW.`status` = 'active'
BEGIN
	SELECT CASE WHEN (
		SELECT COUNT(*) FROM `timelines`
		WHERE `world_id` = NEW.`world_id` AND `status` = 'active'
	) >= 3 THEN RAISE(ABORT, 'active_timeline_limit') END;
END;
--> statement-breakpoint
CREATE TRIGGER `active_timeline_limit_reactivate` BEFORE UPDATE OF `status` ON `timelines`
WHEN NEW.`status` = 'active' AND OLD.`status` <> 'active'
BEGIN
	SELECT CASE WHEN (
		SELECT COUNT(*) FROM `timelines`
		WHERE `world_id` = NEW.`world_id` AND `status` = 'active' AND `id` <> NEW.`id`
	) >= 3 THEN RAISE(ABORT, 'active_timeline_limit') END;
END;
