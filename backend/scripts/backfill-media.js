// Copies existing backend/uploads files into the configured media driver and
// records them in media_objects. Safe to re-run: files already recorded are
// skipped and interrupted runs resume where they stopped.
//
//   npm run media:backfill -- --dry-run
//   MEDIA_DRIVER=s3 S3_*=... npm run media:backfill
//   npm run media:backfill -- --limit=50
require('dotenv').config({ quiet: true })
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const sharp = require('sharp')
const storage = require('../src/storage')
const { detectFileType } = require('../src/media')

const UPLOAD_DIRECTORY = path.join(__dirname, '..', 'uploads')
const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/i
const ADVISORY_LOCK_ID = 72810342

function parseArgs(argv) {
  const options = { dryRun: false, limit: 0, force: false }
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length)) || 0
  }
  return options
}

function connectionString() {
  return process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL
}

function checksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function imageSize(buffer) {
  try {
    const metadata = await sharp(buffer, { limitInputPixels: 80_000_000 }).metadata()
    return { width: metadata.width || null, height: metadata.pageHeight || metadata.height || null }
  } catch {
    return { width: null, height: null }
  }
}

async function referencedFiles(client) {
  const { rows } = await client.query(`SELECT media_url AS url, 'chat' AS kind FROM messages WHERE media_url LIKE '/uploads/%'
    UNION SELECT media_url, 'status' FROM statuses WHERE media_url LIKE '/uploads/%'
    UNION SELECT avatar_url, 'avatar' FROM users WHERE avatar_url LIKE '/uploads/%'
    UNION SELECT avatar_url, 'chat' FROM chats WHERE avatar_url LIKE '/uploads/%'`)
  const kinds = new Map()
  for (const row of rows) if (row.url && !kinds.has(row.url)) kinds.set(row.url, row.kind)
  return kinds
}

async function linkMedia(client, mediaId, url) {
  await client.query('UPDATE messages SET media_id = $1 WHERE media_url = $2 AND media_id IS NULL', [mediaId, url])
  await client.query('UPDATE statuses SET media_id = $1 WHERE media_url = $2 AND media_id IS NULL', [mediaId, url])
  await client.query('UPDATE users SET avatar_media_id = $1 WHERE avatar_url = $2 AND avatar_media_id IS NULL', [mediaId, url])
  await client.query('UPDATE chats SET avatar_media_id = $1 WHERE avatar_url = $2 AND avatar_media_id IS NULL', [mediaId, url])
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const provider = storage.driverName()
  const target = storage.driverFor(provider)
  if (storage.isRemote(provider) && !target.isConfigured()) {
    const missing = typeof target.missingSettings === 'function' ? target.missingSettings().join(', ') : 'credentials'
    throw new Error(`MEDIA_DRIVER=${provider} but storage is not configured (missing ${missing}).`)
  }

  const client = new Client({
    connectionString: connectionString(),
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    application_name: 'chat-app-media-backfill',
  })
  await client.connect()

  let scanned = 0
  let uploaded = 0
  let promoted = 0
  let skipped = 0
  let failed = 0
  let orphaned = 0

  try {
    if (!options.dryRun) {
      await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID])
    }

    const references = await referencedFiles(client)
    const files = fs.existsSync(UPLOAD_DIRECTORY)
      ? fs.readdirSync(UPLOAD_DIRECTORY).filter((name) => FILE_NAME.test(name)).sort()
      : []

    console.log(`Driver: ${provider}${options.dryRun ? ' (dry run)' : ''}`)
    console.log(`Files on disk: ${files.length}; referenced by the database: ${references.size}`)

    const missing = [...references.keys()].filter((url) => !files.includes(path.basename(url)))
    if (missing.length) {
      console.log(`\nWARNING: ${missing.length} referenced file(s) are missing from disk and cannot be backfilled:`)
      for (const url of missing.slice(0, 10)) console.log(`  ${url}`)
    }

    for (const name of files) {
      if (options.limit && scanned >= options.limit) break
      scanned += 1
      const url = `/uploads/${name}`
      const kind = references.get(url)

      if (!kind) {
        orphaned += 1
        continue
      }

      const { rows: existing } = await client.query('SELECT * FROM media_objects WHERE legacy_url = $1', [url])
      if (existing.length) {
        const record = existing[0]
        // A database restored from the local driver still points at disk. When
        // the target is object storage, upload the bytes and flip the row so
        // old media survives the move instead of 404ing after the old disk is
        // gone.
        if (storage.isRemote(provider) && record.storage_provider === 'local') {
          if (options.dryRun) {
            promoted += 1
            continue
          }
          try {
            const buffer = await fs.promises.readFile(path.join(UPLOAD_DIRECTORY, name))
            await target.putObject({ key: record.object_key, body: buffer, contentType: record.mime_type })
            await client.query(`UPDATE media_objects SET storage_provider = $3, bucket = $2,
                delete_error = NULL, delete_attempts = 0 WHERE id = $1`,
              [record.id, storage.bucketName(), provider])
            await linkMedia(client, record.id, url)
            promoted += 1
          } catch (error) {
            failed += 1
            console.log(`  FAIL ${name}: ${error.message}`)
          }
          continue
        }
        if (!options.dryRun) await linkMedia(client, record.id, url)
        skipped += 1
        continue
      }

      try {
        const buffer = await fs.promises.readFile(path.join(UPLOAD_DIRECTORY, name))
        const detected = detectFileType(buffer)
        if (!detected) {
          console.log(`  SKIP ${name} (unrecognised file type)`)
          failed += 1
          continue
        }

        const stat = await fs.promises.stat(path.join(UPLOAD_DIRECTORY, name))
        const date = stat.mtime
        const month = String(date.getUTCMonth() + 1).padStart(2, '0')
        const objectKey = `${storage.prefix()}/${kind}/${date.getUTCFullYear()}/${month}/${name}`
        const dimensions = detected.category === 'image' ? await imageSize(buffer) : { width: null, height: null }

        if (options.dryRun) {
          uploaded += 1
          continue
        }

        if (storage.isRemote(provider)) {
          await target.putObject({ key: objectKey, body: buffer, contentType: detected.mime })
        }

        const { rows: inserted } = await client.query(`INSERT INTO media_objects
            (owner_id, kind, storage_provider, bucket, object_key, legacy_url, mime_type, byte_size, checksum_sha256, width, height)
          VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (legacy_url) DO NOTHING RETURNING id`,
          [kind, provider, storage.bucketName(), objectKey, url, detected.mime, buffer.length,
            checksum(buffer), dimensions.width, dimensions.height])

        if (inserted[0]) {
          await linkMedia(client, inserted[0].id, url)
          uploaded += 1
        } else {
          skipped += 1
        }
      } catch (error) {
        failed += 1
        console.log(`  FAIL ${name}: ${error.message}`)
      }

      if (!options.dryRun && (uploaded + promoted + skipped + failed) % 25 === 0) {
        console.log(`  ... ${scanned} scanned, ${uploaded} uploaded, ${promoted} promoted, ${skipped} skipped, ${failed} failed`)
      }
    }

    if (!options.dryRun) {
      await client.query(`INSERT INTO media_job_state (key, value, updated_at)
        VALUES ('backfill', $1::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify({ finishedAt: new Date().toISOString(), provider, scanned, uploaded, promoted, skipped, failed, orphaned })])
    }

    console.log(`\nScanned ${scanned}, uploaded ${uploaded}, promoted ${promoted}, already recorded ${skipped}, orphaned ${orphaned}, failed ${failed}.`)
    if (options.dryRun) console.log('Dry run: nothing was written.')
    if (failed) process.exitCode = 1
  } finally {
    if (!options.dryRun) await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {})
    await client.end().catch(() => {})
    await require('../src/db').pool.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error(`\nBackfill failed: ${error.message}`)
  process.exit(1)
})
