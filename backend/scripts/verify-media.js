// Verifies that media_objects matches storage and that every referenced file is
// linked. Run after a backfill and before switching MEDIA_DRIVER.
//
//   npm run media:verify
//   npm run media:verify -- --sample=25
require('dotenv').config({ quiet: true })
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const storage = require('../src/storage')

const UPLOAD_DIRECTORY = path.join(__dirname, '..', 'uploads')
const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/i

function sampleSize(argv) {
  const value = argv.find((arg) => arg.startsWith('--sample='))
  return value ? Math.max(0, Number(value.slice('--sample='.length)) || 0) : 10
}

async function readObject(row) {
  if (storage.isRemote(row.storage_provider)) {
    const url = await storage.readUrl({ provider: row.storage_provider, key: row.object_key })
    if (!url) throw new Error(`${row.storage_provider} storage is not configured`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${row.storage_provider} GET returned ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  return fs.promises.readFile(path.join(UPLOAD_DIRECTORY, path.basename(row.object_key)))
}

async function main() {
  const sample = sampleSize(process.argv.slice(2))
  const client = new Client({
    connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    application_name: 'chat-app-media-verify',
  })
  await client.connect()

  const failures = []
  try {
    const { rows: totals } = await client.query(`SELECT storage_provider, kind, COUNT(*)::int AS objects,
        COALESCE(SUM(byte_size), 0)::bigint AS bytes
      FROM media_objects WHERE deleted_at IS NULL
      GROUP BY storage_provider, kind ORDER BY storage_provider, kind`)
    console.log('Recorded media:')
    for (const row of totals) console.log(`  ${row.storage_provider}/${row.kind}: ${row.objects} object(s), ${row.bytes} bytes`)
    if (!totals.length) console.log('  (none)')

    // 1. Size check for every live row.
    const { rows: objects } = await client.query(`SELECT id, storage_provider, object_key, byte_size, checksum_sha256
      FROM media_objects WHERE deleted_at IS NULL ORDER BY created_at`)
    for (const row of objects) {
      try {
        if (!(await storage.exists({ provider: row.storage_provider, key: row.object_key }))) {
          failures.push(`${row.id}: missing in ${row.storage_provider} (${row.object_key})`)
          continue
        }
        const head = storage.isRemote(row.storage_provider)
          ? await storage.headObject({ provider: row.storage_provider, key: row.object_key })
          : { byteSize: (await fs.promises.stat(path.join(UPLOAD_DIRECTORY, path.basename(row.object_key)))).size }
        if (Number(head.byteSize) !== Number(row.byte_size)) {
          failures.push(`${row.id}: size mismatch (db ${row.byte_size}, storage ${head.byteSize})`)
        }
      } catch (error) {
        failures.push(`${row.id}: ${error.message}`)
      }
    }

    // 2. Checksum spot checks.
    const checks = objects.filter((row) => row.checksum_sha256).slice(0, sample)
    for (const row of checks) {
      try {
        const buffer = await readObject(row)
        const digest = crypto.createHash('sha256').update(buffer).digest('hex')
        if (digest !== row.checksum_sha256) failures.push(`${row.id}: checksum mismatch`)
      } catch (error) {
        failures.push(`${row.id}: checksum read failed (${error.message})`)
      }
    }

    // 3. Every legacy URL that still exists in the app should carry a media_id.
    const { rows: unlinked } = await client.query(`SELECT
        (SELECT COUNT(*)::int FROM messages WHERE media_url LIKE '/uploads/%' AND media_id IS NULL) AS messages,
        (SELECT COUNT(*)::int FROM statuses WHERE media_url LIKE '/uploads/%' AND media_id IS NULL) AS statuses,
        (SELECT COUNT(*)::int FROM users WHERE avatar_url LIKE '/uploads/%' AND avatar_media_id IS NULL) AS avatars`)
    for (const [table, count] of Object.entries(unlinked[0])) {
      if (count) failures.push(`${count} ${table} row(s) still have media_url but no media_id`)
    }

    // 4. Files left on disk with no record are leftovers from before the
    //    backfill; they are harmless but should be archived after cutover.
    if (fs.existsSync(UPLOAD_DIRECTORY)) {
      const onDisk = fs.readdirSync(UPLOAD_DIRECTORY).filter((name) => FILE_NAME.test(name))
      const { rows: known } = await client.query(`SELECT legacy_url FROM media_objects WHERE legacy_url IS NOT NULL`)
      const knownNames = new Set(known.map((row) => path.basename(row.legacy_url)))
      const orphans = onDisk.filter((name) => !knownNames.has(name))
      if (orphans.length) console.log(`\nNote: ${orphans.length} file(s) on disk are not recorded (unreferenced or not backfilled).`)
    }

    const { rows: state } = await client.query("SELECT value, updated_at FROM media_job_state WHERE key = 'backfill'")
    if (state[0]) console.log(`\nLast backfill: ${new Date(state[0].updated_at).toISOString()} ${JSON.stringify(state[0].value)}`)

    console.log(`\nChecked ${objects.length} object(s), sampled ${checks.length} checksum(s).`)
    if (failures.length) {
      console.error(`\n${failures.length} problem(s):`)
      for (const failure of failures.slice(0, 50)) console.error(`  - ${failure}`)
      process.exitCode = 1
    } else {
      console.log('Media verification passed.')
    }
  } finally {
    await client.end().catch(() => {})
    await require('../src/db').pool.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error(`\nVerification failed: ${error.message}`)
  process.exit(1)
})
