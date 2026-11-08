-- Remember empty cleanup requests so a delayed retry cannot delete newly eligible history.
ALTER TABLE inventory_cleanup_requests ALTER COLUMN backup_id DROP NOT NULL;
ALTER TABLE inventory_cleanup_requests ADD CONSTRAINT cleanup_result_valid
 CHECK (deleted_count >= 0 AND (backup_id IS NOT NULL OR (deleted_count = 0 AND has_more = false)));
