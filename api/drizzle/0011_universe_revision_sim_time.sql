ALTER TABLE `universe_revisions` ADD `sim_time` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `universe_revisions`
SET `sim_time` = (SELECT `sim_now` FROM `timelines` WHERE `timelines`.`id` = `universe_revisions`.`timeline_id`)
WHERE `sim_time` = '';
--> statement-breakpoint
CREATE TRIGGER `world_facts_revision_time_guard` BEFORE INSERT ON `world_facts`
BEGIN
	SELECT CASE WHEN COALESCE((SELECT `sim_time` FROM `universe_revisions` WHERE `timeline_id` = NEW.`timeline_id`), '') <> NEW.`sim_time`
		THEN RAISE(ABORT, 'world_state_revision_time_conflict') END;
END;
