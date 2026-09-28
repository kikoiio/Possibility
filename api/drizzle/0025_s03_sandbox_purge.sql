DROP TRIGGER `world_commands_immutable_delete`;
--> statement-breakpoint
CREATE TRIGGER `world_commands_immutable_delete` BEFORE DELETE ON `world_commands`
WHEN NOT EXISTS (
	SELECT 1 FROM `demo_sandboxes` s WHERE s.`world_id` = OLD.`world_id` AND s.`status` = 'purging'
)
BEGIN SELECT RAISE(ABORT, 'world_command_immutable'); END;
--> statement-breakpoint
DROP TRIGGER `world_facts_immutable_delete`;
--> statement-breakpoint
CREATE TRIGGER `world_facts_immutable_delete` BEFORE DELETE ON `world_facts`
WHEN NOT EXISTS (
	SELECT 1 FROM `timelines` t JOIN `demo_sandboxes` s ON s.`world_id` = t.`world_id`
	WHERE t.`id` = OLD.`timeline_id` AND s.`status` = 'purging'
)
BEGIN SELECT RAISE(ABORT, 'world_fact_immutable'); END;
--> statement-breakpoint
DROP TRIGGER `world_model_versions_immutable_delete`;
--> statement-breakpoint
CREATE TRIGGER `world_model_versions_immutable_delete` BEFORE DELETE ON `world_model_versions`
WHEN NOT EXISTS (
	SELECT 1 FROM `demo_sandboxes` s WHERE s.`world_id` = OLD.`world_id` AND s.`status` = 'purging'
)
BEGIN SELECT RAISE(ABORT, 'world_model_version_immutable'); END;
