CREATE TRIGGER `world_commands_immutable_update` BEFORE UPDATE ON `world_commands`
BEGIN SELECT RAISE(ABORT, 'world_command_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `world_commands_immutable_delete` BEFORE DELETE ON `world_commands`
BEGIN SELECT RAISE(ABORT, 'world_command_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `world_facts_immutable_update` BEFORE UPDATE ON `world_facts`
BEGIN SELECT RAISE(ABORT, 'world_fact_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `world_facts_immutable_delete` BEFORE DELETE ON `world_facts`
BEGIN SELECT RAISE(ABORT, 'world_fact_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `world_model_versions_immutable_update` BEFORE UPDATE ON `world_model_versions`
BEGIN SELECT RAISE(ABORT, 'world_model_version_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `world_model_versions_immutable_delete` BEFORE DELETE ON `world_model_versions`
BEGIN SELECT RAISE(ABORT, 'world_model_version_immutable'); END;
