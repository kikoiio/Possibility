CREATE TABLE `scene_compatibility_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_request_id` text NOT NULL,
	`actor_key` text NOT NULL,
	`world_id` text NOT NULL,
	`purpose` text NOT NULL,
	`target_json` text NOT NULL,
	`basis_json` text NOT NULL,
	`status` text DEFAULT 'building' NOT NULL,
	`candidate_json` text,
	`changes_json` text DEFAULT '[]' NOT NULL,
	`report_json` text,
	`input_fingerprint` text NOT NULL,
	`build_lease_token` text,
	`build_lease_until` text,
	`build_attempt` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scene_compatibility_draft_scope` ON `scene_compatibility_drafts` (`world_id`,`actor_key`,`draft_request_id`);--> statement-breakpoint
CREATE INDEX `scene_compatibility_draft_status` ON `scene_compatibility_drafts` (`world_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `scene_compatibility_requests` (
	`world_id` text NOT NULL,
	`request_id` text NOT NULL,
	`actor_key` text NOT NULL,
	`draft_id` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'submitting' NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`result_version` integer,
	`failure_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`world_id`, `request_id`),
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`) REFERENCES `scene_compatibility_drafts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scene_compatibility_request_state` ON `scene_compatibility_requests` (`world_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `scene_validation_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`rules_version` text NOT NULL,
	`asset_manifest_hash` text NOT NULL,
	`template_catalog_hash` text NOT NULL,
	`published_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `world_scene_revisions` ADD `compatibility_json` text;--> statement-breakpoint
ALTER TABLE `world_scene_revisions` ADD `validation_json` text;--> statement-breakpoint
ALTER TABLE `world_scene_revisions` ADD `commit_guard` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- A1 B15–B19 写入闸门：commit_guard 只能为 1；发布后（scene_validation_policy 存在 active 行）
-- 新修订必须携带服务端构造的写入依据，且当前/来源/绑定/基线/草稿请求条件在真实插入时核对。
CREATE TRIGGER `world_scene_revision_commit_guard_insert` BEFORE INSERT ON `world_scene_revisions`
WHEN NEW.`commit_guard` <> 1
BEGIN
	SELECT RAISE(ABORT, 'scene_revision_commit_guard_failed');
END;--> statement-breakpoint
CREATE TRIGGER `world_scene_revision_commit_guard_update` AFTER UPDATE OF `commit_guard` ON `world_scene_revisions`
WHEN NEW.`commit_guard` <> 1
BEGIN
	SELECT RAISE(ABORT, 'scene_revision_commit_guard_failed');
END;--> statement-breakpoint
CREATE TRIGGER `world_scene_revision_policy_gate` BEFORE INSERT ON `world_scene_revisions`
WHEN EXISTS (SELECT 1 FROM `scene_validation_policy` WHERE `id` = 'active')
BEGIN
	SELECT CASE WHEN NEW.`validation_json` IS NULL OR NOT json_valid(NEW.`validation_json`)
		THEN RAISE(ABORT, 'scene_revision_proof_required') END;
	SELECT CASE WHEN COALESCE(json_extract(NEW.`validation_json`, '$.schema'), '') <> 'scene-write-proof-v1'
		THEN RAISE(ABORT, 'scene_revision_proof_required') END;
	SELECT CASE WHEN COALESCE(json_extract(NEW.`validation_json`, '$.mode'), '') NOT IN ('valid', 'initial', 'clone-copy')
		THEN RAISE(ABORT, 'scene_revision_proof_mode_unknown') END;
	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM `scene_validation_policy` AS `p`
		WHERE `p`.`id` = 'active'
			AND (COALESCE(json_extract(NEW.`validation_json`, '$.policy.rulesVersion'), '') <> `p`.`rules_version`
				OR COALESCE(json_extract(NEW.`validation_json`, '$.policy.assetManifestHash'), '') <> `p`.`asset_manifest_hash`
				OR COALESCE(json_extract(NEW.`validation_json`, '$.policy.templateCatalogHash'), '') <> `p`.`template_catalog_hash`)
	) THEN RAISE(ABORT, 'scene_revision_policy_mismatch') END;
END;--> statement-breakpoint
CREATE TRIGGER `world_scene_revision_source_gate` BEFORE INSERT ON `world_scene_revisions`
WHEN EXISTS (SELECT 1 FROM `scene_validation_policy` WHERE `id` = 'active')
	AND COALESCE(json_extract(NEW.`validation_json`, '$.schema'), '') = 'scene-write-proof-v1'
	AND COALESCE(json_extract(NEW.`validation_json`, '$.mode'), '') IN ('valid', 'initial', 'clone-copy')
	AND NOT EXISTS (
		SELECT 1 FROM `scene_validation_policy` AS `p`
		WHERE `p`.`id` = 'active'
			AND (COALESCE(json_extract(NEW.`validation_json`, '$.policy.rulesVersion'), '') <> `p`.`rules_version`
				OR COALESCE(json_extract(NEW.`validation_json`, '$.policy.assetManifestHash'), '') <> `p`.`asset_manifest_hash`
				OR COALESCE(json_extract(NEW.`validation_json`, '$.policy.templateCatalogHash'), '') <> `p`.`template_catalog_hash`)
	)
BEGIN
	SELECT CASE WHEN json_extract(NEW.`validation_json`, '$.mode') = 'valid' AND NOT EXISTS (
		SELECT 1 FROM `world_scenes` AS `ws`
		JOIN `world_scene_revisions` AS `cur`
			ON `cur`.`world_id` = `ws`.`world_id` AND `cur`.`version` = `ws`.`current_version`
		WHERE `ws`.`world_id` = NEW.`world_id`
			AND `ws`.`current_version` = json_extract(NEW.`validation_json`, '$.current.expectedVersion')
			AND `cur`.`content_hash` = json_extract(NEW.`validation_json`, '$.current.contentHash')
	) THEN RAISE(ABORT, 'scene_revision_current_mismatch') END;
	SELECT CASE WHEN json_extract(NEW.`validation_json`, '$.mode') = 'valid' AND (
		COALESCE(json_extract(NEW.`validation_json`, '$.source.worldId'), '') <> NEW.`world_id`
		OR NOT EXISTS (
			SELECT 1 FROM `world_scene_revisions` AS `src`
			WHERE `src`.`world_id` = NEW.`world_id`
				AND `src`.`version` = json_extract(NEW.`validation_json`, '$.source.version')
				AND `src`.`content_hash` = json_extract(NEW.`validation_json`, '$.source.contentHash'))
	) THEN RAISE(ABORT, 'scene_revision_source_mismatch') END;
	SELECT CASE WHEN json_extract(NEW.`validation_json`, '$.mode') = 'initial' AND (
		NEW.`version` <> 1 OR NEW.`parent_version` IS NOT NULL
		OR EXISTS (SELECT 1 FROM `world_scenes` AS `ws` WHERE `ws`.`world_id` = NEW.`world_id`)
	) THEN RAISE(ABORT, 'scene_revision_initial_conflict') END;
	SELECT CASE WHEN json_extract(NEW.`validation_json`, '$.mode') = 'clone-copy' AND NOT EXISTS (
		SELECT 1 FROM `world_scene_revisions` AS `src`
		WHERE `src`.`world_id` = json_extract(NEW.`validation_json`, '$.source.worldId')
			AND `src`.`version` = json_extract(NEW.`validation_json`, '$.source.version')
			AND `src`.`content_hash` = json_extract(NEW.`validation_json`, '$.source.contentHash')
	) THEN RAISE(ABORT, 'scene_revision_clone_source_missing') END;
	SELECT CASE WHEN json_extract(NEW.`validation_json`, '$.mode') = 'clone-copy' AND NOT EXISTS (
		SELECT 1 FROM `worlds` AS `w`
		WHERE `w`.`id` = NEW.`world_id`
			AND `w`.`user_id` = json_extract(NEW.`validation_json`, '$.targetOwnerId')
	) THEN RAISE(ABORT, 'scene_revision_clone_target_mismatch') END;
END;--> statement-breakpoint
CREATE TRIGGER `world_scene_revision_authority_gate` BEFORE INSERT ON `world_scene_revisions`
WHEN EXISTS (SELECT 1 FROM `scene_validation_policy` WHERE `id` = 'active')
	AND COALESCE(json_extract(NEW.`validation_json`, '$.schema'), '') = 'scene-write-proof-v1'
	AND COALESCE(json_extract(NEW.`validation_json`, '$.mode'), '') IN ('valid', 'initial', 'clone-copy')
	AND NOT EXISTS (
		SELECT 1 FROM `scene_validation_policy` AS `p`
		WHERE `p`.`id` = 'active'
			AND (COALESCE(json_extract(NEW.`validation_json`, '$.policy.rulesVersion'), '') <> `p`.`rules_version`
				OR COALESCE(json_extract(NEW.`validation_json`, '$.policy.assetManifestHash'), '') <> `p`.`asset_manifest_hash`
				OR COALESCE(json_extract(NEW.`validation_json`, '$.policy.templateCatalogHash'), '') <> `p`.`template_catalog_hash`)
	)
BEGIN
	SELECT CASE WHEN (
		SELECT COUNT(*) FROM `world_persons` WHERE `world_id` = NEW.`world_id`
	) <> COALESCE(json_array_length(json_extract(NEW.`validation_json`, '$.bindings.personIds')), -1)
		THEN RAISE(ABORT, 'scene_revision_binding_mismatch') END;
	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM json_each(json_extract(NEW.`validation_json`, '$.bindings.personIds')) AS `je`
		WHERE NOT EXISTS (
			SELECT 1 FROM `world_persons` AS `wp`
			WHERE `wp`.`world_id` = NEW.`world_id` AND `wp`.`person_id` = `je`.`value`)
	) THEN RAISE(ABORT, 'scene_revision_binding_mismatch') END;
	SELECT CASE WHEN (
		SELECT COUNT(*) FROM json_each((SELECT `locations_json` FROM `worlds` WHERE `id` = NEW.`world_id`))
	) <> COALESCE(json_array_length(json_extract(NEW.`validation_json`, '$.bindings.locations')), -1)
		THEN RAISE(ABORT, 'scene_revision_binding_mismatch') END;
	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM json_each((SELECT `locations_json` FROM `worlds` WHERE `id` = NEW.`world_id`)) AS `wl`
		WHERE NOT EXISTS (
			SELECT 1 FROM json_each(json_extract(NEW.`validation_json`, '$.bindings.locations')) AS `pl`
			WHERE `pl`.`value` = json_extract(`wl`.`value`, '$.name'))
	) THEN RAISE(ABORT, 'scene_revision_binding_mismatch') END;
END;--> statement-breakpoint
CREATE TRIGGER `world_scene_revision_compatibility_gate` BEFORE INSERT ON `world_scene_revisions`
WHEN EXISTS (SELECT 1 FROM `scene_validation_policy` WHERE `id` = 'active')
	AND COALESCE(json_extract(NEW.`validation_json`, '$.schema'), '') = 'scene-write-proof-v1'
	AND COALESCE(json_extract(NEW.`validation_json`, '$.mode'), '') IN ('valid', 'initial', 'clone-copy')
	AND NOT EXISTS (
		SELECT 1 FROM `scene_validation_policy` AS `p`
		WHERE `p`.`id` = 'active'
			AND (COALESCE(json_extract(NEW.`validation_json`, '$.policy.rulesVersion'), '') <> `p`.`rules_version`
				OR COALESCE(json_extract(NEW.`validation_json`, '$.policy.assetManifestHash'), '') <> `p`.`asset_manifest_hash`
				OR COALESCE(json_extract(NEW.`validation_json`, '$.policy.templateCatalogHash'), '') <> `p`.`template_catalog_hash`)
	)
BEGIN
	SELECT CASE WHEN json_extract(NEW.`validation_json`, '$.baseline') IS NULL
		AND EXISTS (SELECT 1 FROM `demo_baselines` AS `b` WHERE `b`.`world_id` = NEW.`world_id`)
		THEN RAISE(ABORT, 'scene_revision_baseline_mismatch') END;
	SELECT CASE WHEN json_extract(NEW.`validation_json`, '$.baseline') IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `demo_baselines` AS `b`
		WHERE `b`.`world_id` = NEW.`world_id`
			AND `b`.`id` = json_extract(NEW.`validation_json`, '$.baseline.id')
			AND `b`.`status` = json_extract(NEW.`validation_json`, '$.baseline.status')
			AND `b`.`scene_version` = json_extract(NEW.`validation_json`, '$.baseline.sceneVersion')
			AND `b`.`content_hash` = json_extract(NEW.`validation_json`, '$.baseline.contentHash')
	) THEN RAISE(ABORT, 'scene_revision_baseline_mismatch') END;
	SELECT CASE WHEN json_extract(NEW.`validation_json`, '$.request') IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `scene_compatibility_drafts` AS `d`
		WHERE `d`.`id` = json_extract(NEW.`validation_json`, '$.request.draftId')
			AND `d`.`world_id` = NEW.`world_id`
			AND `d`.`status` = 'ready'
			AND `d`.`candidate_json` IS NOT NULL
	) THEN RAISE(ABORT, 'scene_revision_draft_not_ready') END;
	SELECT CASE WHEN json_extract(NEW.`validation_json`, '$.request') IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `scene_compatibility_requests` AS `r`
		WHERE `r`.`world_id` = NEW.`world_id`
			AND `r`.`request_id` = json_extract(NEW.`validation_json`, '$.request.requestId')
			AND `r`.`attempt` = json_extract(NEW.`validation_json`, '$.request.attempt')
			AND `r`.`lease_token` = json_extract(NEW.`validation_json`, '$.request.leaseToken')
			AND `r`.`state` = 'submitting'
			AND `r`.`lease_until` > json_extract(NEW.`validation_json`, '$.issuedAt')
	) THEN RAISE(ABORT, 'scene_revision_request_mismatch') END;
END;