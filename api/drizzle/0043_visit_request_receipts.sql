CREATE TABLE `world_visit_requests` (
  `principal_key` text NOT NULL,
  `request_id` text NOT NULL,
  `kind` text NOT NULL,
  `operation` text,
  `world_id` text,
  `timeline_id` text,
  `client_session_id` text,
  `accepted_at` text NOT NULL,
  PRIMARY KEY (`principal_key`, `request_id`),
  CHECK (
    (`kind` = 'request' AND `operation` IS NOT NULL AND `operation` IN ('enter', 'leave')
      AND `world_id` IS NOT NULL AND `timeline_id` IS NOT NULL AND `client_session_id` IS NOT NULL)
    OR
    (`kind` = 'legacy' AND `operation` IS NULL
      AND `world_id` IS NULL AND `timeline_id` IS NULL AND `client_session_id` IS NULL)
  )
);
--> statement-breakpoint
INSERT INTO `world_visit_requests` (
  `principal_key`, `request_id`, `kind`, `operation`, `world_id`, `timeline_id`, `client_session_id`, `accepted_at`
)
SELECT `principal_key`, `last_request_id`, 'legacy', NULL, NULL, NULL, NULL, MIN(`updated_at`)
FROM `world_visit_sessions`
GROUP BY `principal_key`, `last_request_id`;
