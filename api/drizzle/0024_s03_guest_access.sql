CREATE TABLE `demo_baselines` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`scene_version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`retired_at` text,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_baselines_world` ON `demo_baselines` (`world_id`);
--> statement-breakpoint
CREATE INDEX `demo_baselines_status` ON `demo_baselines` (`status`);
--> statement-breakpoint
CREATE TABLE `guest_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`current_sandbox_world_id` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`resume_timeline_id` text,
	`resume_space_id` text DEFAULT 'exterior' NOT NULL,
	`resume_mode` text DEFAULT 'life' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_sandbox_world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resume_timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_sessions_token_hash` ON `guest_sessions` (`token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_sessions_owner` ON `guest_sessions` (`owner_user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_sessions_current_sandbox` ON `guest_sessions` (`current_sandbox_world_id`);
--> statement-breakpoint
CREATE INDEX `guest_sessions_status_expiry` ON `guest_sessions` (`status`,`expires_at`);
--> statement-breakpoint
CREATE TABLE `demo_sandboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`baseline_id` text NOT NULL,
	`world_id` text NOT NULL,
	`generation` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`request_id` text NOT NULL,
	`claimed_world_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `guest_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`baseline_id`) REFERENCES `demo_baselines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claimed_world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_sandboxes_world` ON `demo_sandboxes` (`world_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_sandboxes_generation` ON `demo_sandboxes` (`session_id`,`generation`);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_sandboxes_request` ON `demo_sandboxes` (`session_id`,`request_id`);
--> statement-breakpoint
CREATE INDEX `demo_sandboxes_session_status` ON `demo_sandboxes` (`session_id`,`status`);
--> statement-breakpoint
CREATE INDEX `demo_sandboxes_status_expiry` ON `demo_sandboxes` (`status`,`expires_at`);
