ALTER TABLE `memories` ADD `level` integer;--> statement-breakpoint
UPDATE `memories` SET `level` = 1 WHERE `type` = 'summary' AND `level` IS NULL;
