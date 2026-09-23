CREATE TABLE `engine_tick_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`lease_until` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `world_commands` ADD `tick_lease_token` text;
--> statement-breakpoint
CREATE TRIGGER `world_command_tick_lease_guard` BEFORE INSERT ON `world_commands`
WHEN NEW.`tick_lease_token` IS NOT NULL
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `engine_tick_leases`
		WHERE `id` = 'autonomous-world-tick'
			AND `owner_token` = NEW.`tick_lease_token`
			AND `lease_until` > CAST(strftime('%s', 'now') AS INTEGER) * 1000
	) THEN RAISE(ABORT, 'engine_tick_lease_required') END;
END;
