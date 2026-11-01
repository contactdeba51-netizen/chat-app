-- Media can now live in any S3-compatible private bucket (Neon Object
-- Storage, Backblaze B2), not only Cloudflare R2. Existing rows keep their
-- provider; only the allowed set widens.

ALTER TABLE media_objects
  DROP CONSTRAINT IF EXISTS media_objects_storage_provider_check;

ALTER TABLE media_objects
  ADD CONSTRAINT media_objects_storage_provider_check
  CHECK (storage_provider IN ('local', 'r2', 's3', 'b2'));
