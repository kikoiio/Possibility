ALTER TABLE `worlds` ADD `claim_staging_execution_id` text;
--> statement-breakpoint
CREATE TABLE `demo_claim_operations` (
	`sandbox_id` text PRIMARY KEY NOT NULL REFERENCES `demo_sandboxes`(`id`) ON DELETE CASCADE,
	`request_id` text NOT NULL,
	`target_user_id` text NOT NULL REFERENCES `users`(`id`),
	`epoch` integer NOT NULL DEFAULT 0,
	`execution_id` text,
	`execution_no` integer NOT NULL DEFAULT 0,
	`state` text NOT NULL DEFAULT 'failed',
	`lease_until` text,
	`candidate_world_id` text,
	`failure_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `demo_claim_operations_state` ON `demo_claim_operations` (`state`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `demo_claim_operations_request` ON `demo_claim_operations` (`sandbox_id`,`request_id`);
--> statement-breakpoint
CREATE TRIGGER `demo_claim_candidate_insert_fence` BEFORE INSERT ON `worlds`
WHEN NEW.`claim_staging_execution_id` IS NOT NULL
BEGIN
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM `demo_claim_operations` op
   JOIN `demo_sandboxes` sb ON sb.`id` = op.`sandbox_id`
   WHERE op.`execution_id` = NEW.`claim_staging_execution_id`
     AND op.`state` = 'running'
     AND op.`candidate_world_id` = NEW.`id`
     AND sb.`world_id` <> NEW.`id`
     AND (op.`lease_until` IS NULL OR op.`lease_until` > datetime('now'))
 ) THEN RAISE(ABORT, 'claim_execution_not_active') END;
END;
--> statement-breakpoint
CREATE TRIGGER `demo_claim_publication_fence` BEFORE UPDATE OF `claim_staging_execution_id` ON `worlds`
WHEN OLD.`claim_staging_execution_id` IS NOT NULL AND NEW.`claim_staging_execution_id` IS NULL
BEGIN
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM `demo_claim_operations` op
   WHERE op.`execution_id` = OLD.`claim_staging_execution_id`
     AND op.`candidate_world_id` = OLD.`id`
     AND op.`state` = 'running'
     AND (op.`lease_until` IS NULL OR op.`lease_until` > datetime('now'))
 ) THEN RAISE(ABORT, 'claim_execution_not_active') END;
END;
