CREATE TABLE IF NOT EXISTS `timeline_scene_heads` (
	`world_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`representation` text NOT NULL,
	`current_revision_id` text NOT NULL,
	`current_version` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`world_id`, `timeline_id`, `representation`),
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_revision_id`) REFERENCES `timeline_scene_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `timeline_scene_head_revision` ON `timeline_scene_heads` (`current_revision_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `timeline_scene_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`representation` text NOT NULL,
	`version` integer NOT NULL,
	`history_parent_revision_id` text,
	`request_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`summary` text NOT NULL,
	`kind` text NOT NULL,
	`validation_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `timeline_scene_revision_version` ON `timeline_scene_revisions` (`world_id`,`timeline_id`,`representation`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `timeline_scene_revision_request` ON `timeline_scene_revisions` (`world_id`,`timeline_id`,`representation`,`request_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `timeline_scene_revision_history` ON `timeline_scene_revisions` (`world_id`,`timeline_id`,`representation`,`version`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `timeline_scene_revision_parent` ON `timeline_scene_revisions` (`history_parent_revision_id`);
--> statement-breakpoint
-- Copy only each extant timeline's migration-time current snapshot. Legacy revision
-- chains remain in world_scene_revisions and are deliberately not exposed as history.
INSERT INTO `timeline_scene_revisions` (
	`id`, `world_id`, `timeline_id`, `representation`, `version`, `history_parent_revision_id`,
	`request_id`, `content_hash`, `snapshot_json`, `summary`, `kind`, `validation_json`, `created_at`
)
SELECT
	'timeline-legacy:' || t.`id` || ':voxel:v1', t.`world_id`, t.`id`, 'voxel', 1, NULL,
	'legacy-migration:' || t.`id` || ':voxel:v1', r.`content_hash`, r.`document_json`,
	'迁移时复制旧世界当前场景', 'legacy-migration',
	json_object('schema', 'timeline-scene-write-proof-v1', 'mode', 'legacy-migration',
		'sourceWorldId', t.`world_id`, 'sourceVersion', r.`version`),
	COALESCE(r.`created_at`, s.`updated_at`)
FROM `timelines` AS t
JOIN `world_scenes` AS s ON s.`world_id` = t.`world_id`
JOIN `world_scene_revisions` AS r
	ON r.`world_id` = s.`world_id` AND r.`version` = s.`current_version`
WHERE NOT EXISTS (
	SELECT 1 FROM `timeline_scene_revisions` AS existing
	WHERE existing.`world_id` = t.`world_id` AND existing.`timeline_id` = t.`id`
		AND existing.`representation` = 'voxel' AND existing.`version` = 1
);
--> statement-breakpoint
INSERT INTO `timeline_scene_heads` (
	`world_id`, `timeline_id`, `representation`, `current_revision_id`, `current_version`, `updated_at`
)
SELECT t.`world_id`, t.`id`, 'voxel', r.`id`, 1, r.`created_at`
FROM `timelines` AS t
JOIN `timeline_scene_revisions` AS r
	ON r.`world_id` = t.`world_id` AND r.`timeline_id` = t.`id`
	AND r.`representation` = 'voxel' AND r.`version` = 1
WHERE r.`kind` = 'legacy-migration'
	AND NOT EXISTS (
		SELECT 1 FROM `timeline_scene_heads` AS existing
		WHERE existing.`world_id` = t.`world_id` AND existing.`timeline_id` = t.`id`
			AND existing.`representation` = 'voxel'
	);
