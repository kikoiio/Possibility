ALTER TABLE `scene_requests` ADD `heartbeat_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- A stale worker may not commit a scene after recovery has released its reservation.
CREATE TRIGGER `scene_commit_requires_live_request` BEFORE INSERT ON `world_commands`
WHEN NEW.`id` GLOB 'scene:*' AND NEW.`type` = 'conversation'
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `scene_requests` request
		WHERE request.`id` = substr(NEW.`id`, 7)
			AND request.`dialogue_id` = json_extract(NEW.`payload_json`, '$.dialogueId')
			AND request.`status` = 'pending'
			AND request.`heartbeat_at` > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) - 240000
	) THEN RAISE(ABORT, 'scene_request_not_live') END;
END;
