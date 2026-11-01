// Forward-only database migrations.
//
//   npm run db:status     show applied / pending migrations and checksum drift
//   npm run db:migrate    apply every pending migration
//   npm run db:baseline   record 0001 on a database that already has the schema
//
// Migrations run over DIRECT_DATABASE_URL when it is set (Neon requires a
// session connection for advisory locks). Files tagged `-- migrate:no-transaction`
// run statement by statement, which is required for CREATE INDEX CONCURRENTLY.
require('dotenv').config({ quiet: true })
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')

const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations')
const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/i
const ADVISORY_LOCK_ID = 72810341

function checksum(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

// Splits a migration into statements while respecting comments, quoted
// strings, and dollar-quoted bodies (used by DO blocks and functions).
function splitStatements(sql) {
  const statements = []
  let start = 0
  let index = 0
  let state = 'normal'
  let dollarTag = ''

  while (index < sql.length) {
    const char = sql[index]
    const next = sql[index + 1]

    if (state === 'normal') {
      if (char === '-' && next === '-') { state = 'lineComment'; index += 2; continue }
      if (char === '/' && next === '*') { state = 'blockComment'; index += 2; continue }
      if (char === "'") { state = 'single'; index += 1; continue }
      if (char === '"') { state = 'double'; index += 1; continue }
      if (char === '$') {
        const match = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index))
        if (match) { state = 'dollar'; dollarTag = match[0]; index += dollarTag.length; continue }
      }
      if (char === ';') {
        const statement = sql.slice(start, index).trim()
        if (statement) statements.push(statement)
        start = index + 1
      }
      index += 1
      continue
    }

    if (state === 'lineComment') {
      if (char === '\n') state = 'normal'
      index += 1
      continue
    }
    if (state === 'blockComment') {
      if (char === '*' && next === '/') { state = 'normal'; index += 2; continue }
      index += 1
      continue
    }
    if (state === 'single') {
      if (char === "'" && next === "'") { index += 2; continue }
      if (char === "'") state = 'normal'
      index += 1
      continue
    }
    if (state === 'double') {
      if (char === '"' && next === '"') { index += 2; continue }
      if (char === '"') state = 'normal'
      index += 1
      continue
    }
    // dollar-quoted body
    if (sql.startsWith(dollarTag, index)) { index += dollarTag.length; state = 'normal'; continue }
    index += 1
  }

  const tail = sql.slice(start).trim()
  if (tail) statements.push(tail)
  return statements
}

function loadMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`)
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => MIGRATION_FILE.test(file))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
      const [, version, name] = MIGRATION_FILE.exec(file)
      return {
        version: Number(version),
        name,
        file,
        sql,
        checksum: checksum(sql),
        noTransaction: /^\s*--\s*migrate:no-transaction\s*$/im.test(sql),
      }
    })
}

async function ensureHistoryTable(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    execution_ms INTEGER NOT NULL DEFAULT 0
  )`)
}

async function loadApplied(client) {
  const { rows } = await client.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
  return rows
}

async function hasBaselineSchema(client) {
  const { rows } = await client.query(`SELECT to_regclass('public.users') IS NOT NULL AS users,
    to_regclass('public.chats') IS NOT NULL AS chats,
    to_regclass('public.messages') IS NOT NULL AS messages`)
  return rows[0].users && rows[0].chats && rows[0].messages
}

async function record(client, migration, executionMs) {
  await client.query(`INSERT INTO schema_migrations (version, name, checksum, execution_ms)
    VALUES ($1, $2, $3, $4) ON CONFLICT (version) DO NOTHING`,
    [migration.version, migration.name, migration.checksum, Math.max(0, Math.round(executionMs))])
}

// A failed CONCURRENTLY build leaves an invalid index behind. Those are never
// used by the planner, so dropping them is always safe and lets a retry work.
async function dropInvalidIndexes(client) {
  const { rows } = await client.query(`SELECT n.nspname AS schema, c.relname AS name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT i.indisvalid AND n.nspname = current_schema()`)
  for (const row of rows) {
    console.log(`  dropping invalid index ${row.schema}.${row.name}`)
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${row.schema}"."${row.name}"`)
  }
}

async function applyMigration(client, migration) {
  const startedAt = Date.now()
  const statements = splitStatements(migration.sql)
  console.log(`\n> ${migration.file}`)

  if (migration.noTransaction) {
    await dropInvalidIndexes(client)
    for (const statement of statements) await client.query(statement)
    await record(client, migration, Date.now() - startedAt)
  } else {
    await client.query('BEGIN')
    try {
      for (const statement of statements) await client.query(statement)
      await record(client, migration, Date.now() - startedAt)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
  }

  console.log(`  applied in ${Date.now() - startedAt} ms`)
}

async function status(client) {
  await ensureHistoryTable(client)
  const applied = await loadApplied(client)
  const migrations = loadMigrations()
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]))

  console.log(`\nDatabase: ${describe(connectionString())}`)
  console.log('')
  for (const migration of migrations) {
    const record = appliedByVersion.get(migration.version)
    if (!record) {
      console.log(`  PENDING  ${migration.file}`)
      continue
    }
    const drift = record.checksum !== migration.checksum ? '  (file changed since it was applied!)' : ''
    console.log(`  applied  ${migration.file}  ${new Date(record.applied_at).toISOString()}${drift}`)
  }

  const unknown = applied.filter((row) => !migrations.some((migration) => migration.version === row.version))
  for (const row of unknown) console.log(`  unknown  ${row.name} (applied but no matching file)`)

  if (!applied.length && await hasBaselineSchema(client)) {
    console.log('\nThis database already has the schema but no migration history.')
    console.log('Run "npm run db:baseline" once, then "npm run db:migrate".')
  }

  const pending = migrations.filter((migration) => !appliedByVersion.has(migration.version))
  console.log(`\n${applied.length} applied, ${pending.length} pending.`)
  if (applied.some((row) => {
    const match = migrations.find((migration) => migration.version === row.version)
    return match && match.checksum !== row.checksum
  })) {
    const error = new Error('An applied migration file has changed. Restore the original file or add a new migration instead.')
    error.status = 1
    throw error
  }
}

async function migrate(client) {
  await ensureHistoryTable(client)
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID])
  try {
    const applied = await loadApplied(client)
    const appliedByVersion = new Map(applied.map((row) => [row.version, row]))
    const migrations = loadMigrations()

    for (const migration of migrations) {
      const record = appliedByVersion.get(migration.version)
      if (record) {
        if (record.checksum !== migration.checksum) {
          throw new Error(`${migration.file} changed after it was applied. Add a new migration instead of editing history.`)
        }
        continue
      }
      if (!appliedByVersion.size && migration.version === 1 && await hasBaselineSchema(client)) {
        throw new Error('Existing schema detected without migration history. Run "npm run db:baseline" first (this records 0001 without re-running it).')
      }
      await applyMigration(client, migration)
      appliedByVersion.set(migration.version, { version: migration.version })
    }

    const pending = loadMigrations().filter((migration) => !appliedByVersion.has(migration.version))
    console.log(pending.length ? `\n${pending.length} migration(s) still pending.` : '\nDatabase is up to date.')
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {})
  }
}

async function baseline(client) {
  await ensureHistoryTable(client)
  const applied = await loadApplied(client)
  if (applied.some((row) => row.version === 1)) {
    console.log('0001_baseline is already recorded. Nothing to do.')
    return
  }
  if (!(await hasBaselineSchema(client))) {
    throw new Error('No existing schema found. Run "npm run db:migrate" to build a fresh database.')
  }
  const migration = loadMigrations().find((item) => item.version === 1)
  if (!migration) throw new Error('0001_baseline.sql is missing from database/migrations.')
  await record(client, migration, 0)
  console.log('Recorded 0001_baseline as applied (no SQL executed).')
  console.log('Next: npm run db:migrate')
}

function connectionString() {
  return process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL
}

function describe(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}`
  } catch {
    return '(unparsable connection string)'
  }
}

async function main() {
  const command = (process.argv[2] || 'status').toLowerCase()
  const url = connectionString()
  if (!url) throw new Error('Set DIRECT_DATABASE_URL (preferred) or DATABASE_URL before running migrations.')

  const client = new Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    application_name: 'chat-app-migrations',
  })
  await client.connect()
  try {
    if (command === 'status') await status(client)
    else if (command === 'up' || command === 'migrate') await migrate(client)
    else if (command === 'baseline') await baseline(client)
    else throw new Error(`Unknown command "${command}". Use status, up, or baseline.`)
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(`\nMigration failed: ${error.message}`)
  process.exit(1)
})

module.exports = { main, splitStatements, loadMigrations }
