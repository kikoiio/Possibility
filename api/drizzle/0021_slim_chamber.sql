CREATE TABLE `universe_evidence` (
	`timeline_id` text PRIMARY KEY NOT NULL,
	`level` text DEFAULT 'unassessed' NOT NULL,
	`assessed_version` integer,
	`baseline_version` integer,
	`reason_codes_json` text DEFAULT '[]' NOT NULL,
	`assessed_at` text NOT NULL,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `universe_evidence_level` ON `universe_evidence` (`level`);--> statement-breakpoint
CREATE TRIGGER `world_command_requires_complete_evidence`
BEFORE INSERT ON `world_commands`
WHEN NOT EXISTS (
	SELECT 1 FROM `universe_evidence`
	WHERE `timeline_id` = NEW.`timeline_id`
		AND `level` = 'complete'
		AND `assessed_version` = NEW.`expected_version`
)
BEGIN
	SELECT RAISE(ABORT, 'universe_evidence_incomplete');
END;--> statement-breakpoint
CREATE TRIGGER `timeline_reactivate_requires_complete_evidence`
BEFORE UPDATE OF `status` ON `timelines`
WHEN NEW.`status` = 'active'
	AND OLD.`status` <> 'active'
	AND NOT EXISTS (
		SELECT 1 FROM `universe_evidence`
		WHERE `timeline_id` = NEW.`id` AND `level` = 'complete'
	)
BEGIN
	SELECT RAISE(ABORT, 'universe_evidence_incomplete');
END;--> statement-breakpoint
ALTER TABLE `llm_call_log` ADD `request_id` text;--> statement-breakpoint
ALTER TABLE `llm_call_log` ADD `context_hash` text;--> statement-breakpoint
ALTER TABLE `llm_call_log` ADD `contract_version` text;--> statement-breakpoint
ALTER TABLE `llm_call_log` ADD `status` text;--> statement-breakpoint
ALTER TABLE `llm_call_log` ADD `error_code` text;--> statement-breakpoint
ALTER TABLE `llm_call_log` ADD `completed_at` text;--> statement-breakpoint
INSERT INTO `universe_evidence` (
	`timeline_id`,
	`level`,
	`assessed_version`,
	`baseline_version`,
	`reason_codes_json`,
	`assessed_at`
)
SELECT
	`id`,
	'unassessed',
	NULL,
	NULL,
	'["legacy_unassessed"]',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `timelines`;--> statement-breakpoint
CREATE TRIGGER `chat_reply_requires_pending_request`
BEFORE INSERT ON `messages`
WHEN EXISTS (
	SELECT 1
	FROM `chat_requests`
	WHERE `reply_message_id` = NEW.`id`
		AND `status` <> 'pending'
)
BEGIN
	SELECT RAISE(ABORT, 'chat request is not pending');
END;
