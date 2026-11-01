// Media pipeline: sniff the real file type, normalise images, enforce account
// quotas, and keep bytes and metadata in sync.
const crypto = require('node:crypto')
const sharp = require('sharp')
const { query, transaction } = require('./db')
const storage = require('./storage')

// Small instances (Render free is 512 MB) should not decode several large
// images at once.
sharp.concurrency(1)
sharp.cache(false)

const MAX_PIXELS = Number(process.env.MEDIA_MAX_PIXELS) || 40_000_000
const MAX_DIMENSION = Number(process.env.MEDIA_MAX_DIMENSION) || 4096
const ACCOUNT_QUOTA_BYTES = Number(process.env.MEDIA_ACCOUNT_QUOTA_BYTES) || 1024 * 1024 * 1024
const DAILY_QUOTA_BYTES = Number(process.env.MEDIA_DAILY_QUOTA_BYTES) || 100 * 1024 * 1024
const MAX_OBJECTS = Number(process.env.MEDIA_MAX_OBJECTS) || 1000
const FILE_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/

function fail(message, status, code) {
  const error = new Error(message)
  error.status = status
  if (code) error.code = code
  return error
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024 * 1024))} GB`
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

// Magic bytes are authoritative; the browser-supplied MIME type is only a hint.
function detectFileType(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', category: 'image' }
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png', category: 'image' }
  }
  const header6 = buffer.subarray(0, 6).toString('ascii')
  if (header6 === 'GIF87a' || header6 === 'GIF89a') {
    return { mime: 'image/gif', ext: 'gif', category: 'image' }
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp', category: 'image' }
  }
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii')
    return brand === 'qt  '
      ? { mime: 'video/quicktime', ext: 'mov', category: 'video' }
      : { mime: 'video/mp4', ext: 'mp4', category: 'video' }
  }
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return { mime: 'video/webm', ext: 'webm', category: 'video' }
  }
  return null
}

async function processUpload({ buffer, kind }) {
  const detected = detectFileType(buffer)
  if (!detected) throw fail('That file type is not supported. Use JPEG, PNG, WebP, GIF, MP4, WebM, or MOV.', 400, 'MEDIA_TYPE')
  if (kind !== 'status' && detected.category !== 'image') throw fail('Only images can be used here.', 400, 'MEDIA_TYPE')

  if (detected.category === 'video') {
    if (kind !== 'status') throw fail('Only status updates can include video.', 400, 'MEDIA_TYPE')
    // Duration needs ffprobe, which managed hosts do not ship by default. The
    // size cap and container check still block everything else.
    return { ...detected, buffer, width: null, height: null }
  }

  let metadata
  try {
    metadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS, animated: detected.mime === 'image/gif' }).metadata()
  } catch {
    throw fail('That image could not be read.', 400, 'MEDIA_TYPE')
  }
  const width = Number(metadata.width) || 0
  const height = Number(metadata.pageHeight || metadata.height) || 0
  if (!width || !height) throw fail('That image could not be read.', 400, 'MEDIA_TYPE')
  if (width * height > MAX_PIXELS) throw fail(`That image is too large. Keep it under ${Math.round(MAX_PIXELS / 1_000_000)} megapixels.`, 413, 'MEDIA_TOO_LARGE')
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw fail(`Images must be at most ${MAX_DIMENSION} px wide and tall.`, 413, 'MEDIA_TOO_LARGE')

  // Animated GIFs are passed through to keep their frames; everything else is
  // re-encoded, which strips EXIF/GPS and neutralises malformed payloads.
  if (detected.mime === 'image/gif') return { ...detected, buffer, width, height }

  try {
    let pipeline = sharp(buffer, { limitInputPixels: MAX_PIXELS })
      .rotate()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    if (detected.mime === 'image/jpeg') pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true })
    else if (detected.mime === 'image/png') pipeline = pipeline.png({ compressionLevel: 9 })
    else pipeline = pipeline.webp({ quality: 82 })
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
    return { ...detected, buffer: data, width: info.width, height: info.height }
  } catch {
    throw fail('That image could not be processed.', 400, 'MEDIA_TYPE')
  }
}

function checksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

// Writes bytes first, then records metadata. If the quota check rejects the
// upload the freshly written object is removed again, so nothing leaks.
async function storeUpload({ userId, kind, processed }) {
  const objectKey = storage.buildObjectKey(kind, processed.ext)
  const fileName = storage.fileNameFromKey(objectKey)
  const legacyUrl = `/uploads/${fileName}`
  const byteSize = processed.buffer.length
  const stored = await storage.putObject({ key: objectKey, body: processed.buffer, contentType: processed.mime })

  try {
    const row = await transaction(async (client) => {
      // Serialize uploads per account so two concurrent requests cannot both
      // slip under the quota.
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
      const { rows } = await client.query(`SELECT COALESCE(SUM(byte_size), 0)::bigint AS total,
          COALESCE(SUM(byte_size) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0)::bigint AS daily,
          COUNT(*)::int AS objects
        FROM media_objects WHERE owner_id = $1 AND deleted_at IS NULL`, [userId])
      const usage = rows[0]
      if (Number(usage.total) + byteSize > ACCOUNT_QUOTA_BYTES) {
        throw fail(`Your ${formatBytes(ACCOUNT_QUOTA_BYTES)} media storage is full. Delete some photos and try again.`, 413, 'MEDIA_QUOTA')
      }
      if (Number(usage.daily) + byteSize > DAILY_QUOTA_BYTES) {
        throw fail('You have reached the daily upload limit. Try again tomorrow.', 429, 'MEDIA_DAILY_QUOTA')
      }
      if (usage.objects >= MAX_OBJECTS) {
        throw fail(`An account can store at most ${MAX_OBJECTS} files.`, 413, 'MEDIA_QUOTA')
      }
      const { rows: inserted } = await client.query(`INSERT INTO media_objects
          (owner_id, kind, storage_provider, bucket, object_key, legacy_url, mime_type, byte_size, checksum_sha256, width, height)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [userId, kind, stored.provider, stored.bucket, objectKey, legacyUrl, processed.mime, byteSize, checksum(processed.buffer), processed.width, processed.height])
      return inserted[0]
    })

    return {
      id: row.id,
      storedUrl: legacyUrl,
      fileName,
      mime: processed.mime,
      byteSize,
      width: processed.width,
      height: processed.height,
    }
  } catch (error) {
    await storage.deleteObject({ provider: stored.provider, key: objectKey }).catch(() => {})
    throw error
  }
}

function fileNameFromUrl(storedUrl) {
  const match = /^\/uploads\/([^/]+)$/.exec(String(storedUrl || ''))
  return match && FILE_NAME_PATTERN.test(match[1]) ? match[1] : null
}

async function getMediaByUrl(storedUrl) {
  const fileName = fileNameFromUrl(storedUrl)
  if (!fileName) return null
  const { rows } = await query('SELECT * FROM media_objects WHERE legacy_url = $1', [`/uploads/${fileName}`])
  return rows[0] || null
}

// Chat attachments must be owned by the sender, or already shared in a chat
// they belong to (forwarding). Rows created before media_objects existed have
// no metadata, so those keep working to avoid breaking old conversations.
async function assertMediaUsable(storedUrl, userId, expectedKind = 'chat') {
  const fileName = fileNameFromUrl(storedUrl)
  if (!fileName) throw fail('Attach photos with the upload button.', 400, 'MEDIA_TYPE')
  const media = await getMediaByUrl(storedUrl)
  if (!media) return null
  if (media.deleted_at) throw fail('That photo is no longer available.', 410, 'MEDIA_GONE')
  if (expectedKind && media.kind !== expectedKind) throw fail('That file cannot be attached here.', 400, 'MEDIA_KIND')
  if (media.owner_id === userId) return media

  const url = `/uploads/${fileName}`
  const { rowCount } = await query(`SELECT 1 FROM messages m WHERE m.media_url = $1 AND (
      m.chat_id IN (SELECT id FROM chats WHERE type = 'direct' AND ($2 = user_one_id OR $2 = user_two_id))
      OR m.chat_id IN (SELECT chat_id FROM group_members WHERE user_id = $2)) LIMIT 1`, [url, userId])
  if (rowCount) return media
  throw fail('You can only attach files you uploaded.', 403, 'MEDIA_OWNER')
}

// Removes bytes only when nothing references them. Metadata is retained with a
// deleted timestamp so an old signed link stops resolving instead of 404ing
// into a broken image forever.
async function deleteStoredFile(storedUrl) {
  const fileName = fileNameFromUrl(storedUrl)
  if (!fileName) return
  const url = `/uploads/${fileName}`
  const { rowCount } = await query(`SELECT 1 FROM messages WHERE media_url = $1
    UNION SELECT 1 FROM statuses WHERE media_url = $1
    UNION SELECT 1 FROM users WHERE avatar_url = $1
    UNION SELECT 1 FROM chats WHERE avatar_url = $1 LIMIT 1`, [url])
  if (rowCount) return

  const media = await getMediaByUrl(url)
  if (!media) {
    await storage.local.deleteObject(fileName)
    return
  }

  // Mark the row first so the long-lived link stops working immediately, even
  // if the storage provider has not confirmed the delete yet. The hourly
  // cleanup retries anything left in pending_delete.
  await query(`UPDATE media_objects SET deleted_at = NOW(), status = 'pending_delete',
    delete_requested_at = COALESCE(delete_requested_at, NOW()), delete_error = NULL WHERE id = $1`, [media.id])
  try {
    await storage.deleteObject({ provider: media.storage_provider, key: media.object_key })
    await query(`UPDATE media_objects SET status = 'deleted', delete_error = NULL WHERE id = $1`, [media.id])
  } catch (error) {
    await query(`UPDATE media_objects SET delete_error = $2, delete_attempts = delete_attempts + 1
      WHERE id = $1`, [media.id, error.message]).catch(() => {})
  }
}

module.exports = {
  detectFileType,
  processUpload,
  storeUpload,
  fileNameFromUrl,
  getMediaByUrl,
  assertMediaUsable,
  deleteStoredFile,
  formatBytes,
  limits: { ACCOUNT_QUOTA_BYTES, DAILY_QUOTA_BYTES, MAX_OBJECTS, MAX_PIXELS, MAX_DIMENSION },
}
