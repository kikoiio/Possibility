CREATE TABLE `world_visit_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `principal_key` text NOT NULL,
  `user_id` text REFERENCES `users`(`id`),
  `guest_session_id` text REFERENCES `guest_sessions`(`id`),
  `world_id` text NOT NULL REFERENCES `worlds`(`id`),
  `timeline_id` text NOT NULL REFERENCES `timelines`(`id`),
  `client_session_id` text NOT NULL,
  `status` text NOT NULL DEFAULT 'open',
  `entered_sim_time` text NOT NULL,
  `entered_at` text NOT NULL,
  `exited_sim_time` text,
  `exited_at` text,
  `last_request_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `world_visit_session_client` ON `world_visit_sessions` (`principal_key`, `world_id`, `timeline_id`, `client_session_id`);
--> statement-breakpoint
CREATE INDEX `world_visit_session_scope` ON `world_visit_sessions` (`principal_key`, `world_id`, `timeline_id`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `world_visit_session_status` ON `world_visit_sessions` (`status`, `updated_at`);
