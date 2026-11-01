// Copies every application row from one PostgreSQL database to another, in
// foreign-key order. Built for moving the local database to Neon without
// pg_dump/pg_restore (the portable server install does not ship them).
//
//   1. Point the target at Neon and apply migrations:
//        DATABASE_URL=... DIRECT_DATABASE_URL=... npm run db:migrate
//   2. Preview, then copy:
//        SOURCE_DATABASE_URL=postgresql://postgres:...@localhost:5432/chat_app \
//        DIRECT_DATABASE_URL=postgresql://...neon.tech/chat_app?sslmode=require \
//        npm run db:copy -- --dry-run
//        npm run db:copy
//   3. Move the media bytes (npm run media:backfill with MEDIA_DRIVER=s3) and
//      verify with npm run media:verify.
//
// The target must be empty unless --truncate is passed. Existing rows are
// never overwritten silently; conflicting primary keys are skipped.
require('dotenv').config({ quiet: true })
const { Client } = require('pg')

const ADVISORY_LOCK_ID = 72810344
const BATCH_SIZE = 500

function parseArgs(argv) {
  const options = { dryRun: false, truncate: false }
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--truncate') options.truncate = true
  }
  return options
}

function sslFor(url, useEnvironment = false) {
  if (/[?&]sslmode=(require|verify-ca|verify-full)/.test(url)) return { rejectUnauthorized: false }
  if (useEnvironment && process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: false }
  return undefined
}

function describe(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}`
  } catch {
    return '(unparsable connection string)'
  }
}

function quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

async function columnsOf(client, table) {
  const { rows } = await client.query(`SELECT column_name, column_default, is_generated, is_identity, identity_generation
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position`, [table])
  return rows
}

async function primaryKeyOf(client, table) {
  const { rows } = await client.query(`SELECT a.attname AS column
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = $1::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)`, [table])
  return rows.map((row) => row.column)
}

async function foreignKeyEdges(client) {
  const { rows } = await client.query(`SELECT c.conrelid::regclass::text AS child,
      c.confrelid::regclass::text AS parent,
      a.attname AS column,
      a.attnotnull AS required
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.connamespace = 'public'::regnamespace
      AND array_length(c.conkey, 1) = 1`)
  return rows.map((row) => ({
    child: row.child.replace(/^public\./, ''),
    parent: row.parent.replace(/^public\./, ''),
    column: row.column,
    required: row.required,
    self: row.child === row.parent,
  }))
}

function kahn(tables, edges) {
  const parents = new Map(tables.map((table) => [table, new Set()]))
  for (const edge of edges) {
    if (!edge.self && parents.has(edge.child) && parents.has(edge.parent)) {
      parents.get(edge.child).add(edge.parent)
    }
  }
  const ordered = []
  const placed = new Set()
  while (ordered.length < tables.length) {
    const next = tables.filter((table) => !placed.has(table) && [...parents.get(table)].every((parent) => placed.has(parent)))
    if (!next.length) break
    for (const table of next) {
      ordered.push(table)
      placed.add(table)
    }
  }
  return { ordered, placed, stuck: ordered.length < tables.length }
}

function reaches(from, to, edges, seen = new Set()) {
  if (from === to) return true
  if (seen.has(from)) return false
  seen.add(from)
  for (const edge of edges) {
    if (edge.child === from && reaches(edge.parent, to, edges, seen)) return true
  }
  return false
}

// Returns tables with every parent before its children plus the nullable FK
// columns that must be written later. Cycles (users.avatar_media_id <->
// media_objects.owner_id) are broken by deferring a nullable edge.
async function orderTables(client, tables) {
  const edges = await foreignKeyEdges(client)
  const deferred = new Map(tables.map((table) => [table, new Set()]))
  for (const edge of edges) {
    if (edge.self && deferred.has(edge.child)) deferred.get(edge.child).add(edge.column)
  }
  let working = edges.filter((edge) => !edge.self && tables.includes(edge.child) && tables.includes(edge.parent))

  for (;;) {
    const { ordered, stuck } = kahn(tables, working)
    if (!stuck) return { ordered, deferred }

    // Only an edge that is genuinely part of a cycle can be broken. Reserving
    // this for real cycles avoids deferring unrelated nullable keys.
    const breakable = working.find((edge) => !edge.required
      && !deferred.get(edge.child)?.has(edge.column)
      && reaches(edge.parent, edge.child, working))
    if (!breakable) {
      throw new Error('Cannot order tables because of a non-nullable foreign-key cycle.')
    }
    console.log(`  deferring ${breakable.child}.${breakable.column} to break a circular reference`)
    deferred.get(breakable.child).add(breakable.column)
    working = working.filter((edge) => edge !== breakable)
  }
}

async function tableCounts(client, tables) {
  const counts = {}
  for (const table of tables) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS count FROM ${quote(table)}`)
    counts[table] = rows[0].count
  }
  return counts
}

async function resetSequence(client, table, column) {
  const { rows } = await client.query('SELECT pg_get_serial_sequence($1, $2) AS sequence', [table, column])
  const sequence = rows[0]?.sequence
  if (!sequence) return
  await client.query(`SELECT setval($1, COALESCE((SELECT MAX(${quote(column)}) FROM ${quote(table)}), 1),
    (SELECT MAX(${quote(column)}) FROM ${quote(table)}) IS NOT NULL)`, [sequence])
}

async function copyTable(source, target, table, options, deferredColumns = new Set()) {
  const columns = await columnsOf(source, table)
  const writable = columns.filter((column) => column.is_generated !== 'ALWAYS')
  const names = writable.map((column) => column.column_name)
  const pk = await primaryKeyOf(source, table)

  // Self-references and circular foreign keys (messages.reply_to_id,
  // users.avatar_media_id) go in as NULL, then get patched once every row
  // exists. The values are kept in memory, which is fine for a chat database
  // of this size.
  const deferred = new Map([...deferredColumns].map((column) => [column, []]))
  const requiresPrimaryKey = deferred.size > 0
  if (requiresPrimaryKey && pk.length !== 1) {
    throw new Error(`${table} has a deferred foreign key but not a single-column primary key.`)
  }

  const { rows } = await source.query(`SELECT ${names.map(quote).join(', ')} FROM ${quote(table)}
    ORDER BY ${pk.length ? pk.map(quote).join(', ') : '1'}`)
  if (!rows.length) return { copied: 0, skipped: 0, patches: [] }

  const overriding = writable.some((column) => column.is_identity === 'YES' && column.identity_generation === 'ALWAYS')
    ? ' OVERRIDING SYSTEM VALUE'
    : ''
  let copied = 0
  let skipped = 0

  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE)
    const values = []
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = names.map((name, columnIndex) => {
        let value = row[name]
        if (deferred.has(name)) {
          if (value !== null) deferred.get(name).push({ key: row[pk[0]], value })
          value = null
        }
        values.push(value)
        return `$${rowIndex * names.length + columnIndex + 1}`
      })
      return `(${placeholders.join(', ')})`
    })

    if (options.dryRun) {
      copied += batch.length
      continue
    }

    const { rowCount } = await target.query(`INSERT INTO ${quote(table)} (${names.map(quote).join(', ')})${overriding}
      VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, values)
    copied += rowCount
    skipped += batch.length - rowCount
  }

  if (!options.dryRun) {
    for (const column of writable) {
      if (column.is_identity === 'YES' || /nextval\(/i.test(String(column.column_default || ''))) {
        await resetSequence(target, table, column.column_name)
      }
    }
  }

  // Patched after every table is copied, because a deferred key may point at a
  // table that has not been inserted yet.
  const patches = []
  if (!options.dryRun) {
    for (const [column, links] of deferred) {
      for (const link of links) {
        patches.push({ table, column, keyColumn: pk[0], key: link.key, value: link.value })
      }
    }
  }

  return { copied, skipped, patches }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const sourceUrl = process.env.SOURCE_DATABASE_URL
  const targetUrl = process.env.TARGET_DATABASE_URL || process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL
  if (!sourceUrl) throw new Error('Set SOURCE_DATABASE_URL to the database you are copying from.')
  if (!targetUrl) throw new Error('Set TARGET_DATABASE_URL (preferred) or DIRECT_DATABASE_URL to the destination.')

  const sourceIdentity = describe(sourceUrl)
  const targetIdentity = describe(targetUrl)
  if (sourceIdentity === targetIdentity) throw new Error('Source and target are the same database. Refusing to copy.')

  const source = new Client({ connectionString: sourceUrl, ssl: sslFor(sourceUrl), application_name: 'chat-app-copy-source' })
  const target = new Client({ connectionString: targetUrl, ssl: sslFor(targetUrl, true), application_name: 'chat-app-copy-target' })
  await source.connect()
  await target.connect()

  console.log(`Source: ${sourceIdentity}`)
  console.log(`Target: ${targetIdentity}${options.dryRun ? ' (dry run)' : ''}`)

  try {
    const { rows: targetTables } = await target.query(`SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' ORDER BY tablename`)
    if (!targetTables.length) throw new Error('The target has no tables. Run "npm run db:migrate" against it first.')
    if (!targetTables.some((row) => row.tablename === 'users')) {
      throw new Error('The target is missing the users table. Run "npm run db:migrate" against it first.')
    }

    const tables = targetTables.map((row) => row.tablename)
    const copyTables = tables.filter((table) => table !== 'schema_migrations')

    const targetCounts = await tableCounts(target, copyTables)
    const populated = copyTables.filter((table) => targetCounts[table] > 0)
    if (populated.length && !options.truncate) {
      throw new Error(`The target already has data (${populated.join(', ')}). Re-run with --truncate only if you are certain it can be replaced.`)
    }

    const { ordered, deferred } = await orderTables(target, copyTables)
    const sourceCounts = await tableCounts(source, copyTables)
    if (!options.dryRun) await target.query('BEGIN')
    try {
      if (!options.dryRun) {
        await target.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_ID])
        if (options.truncate) {
          await target.query(`TRUNCATE TABLE ${ordered.map(quote).join(', ')} RESTART IDENTITY CASCADE`)
          console.log('Target tables truncated.')
        }
      }

      let copiedTotal = 0
      let skippedTotal = 0
      const patches = []
      for (const table of ordered) {
        const { copied, skipped, patches: tablePatches } = await copyTable(source, target, table, options, deferred.get(table))
        copiedTotal += copied
        skippedTotal += skipped
        patches.push(...tablePatches)
        const detail = skipped ? ` (${skipped} already present)` : ''
        console.log(`  ${table}: ${copied}/${sourceCounts[table]} rows${detail}`)
      }
      if (!options.dryRun) {
        for (const patch of patches) {
          await target.query(`UPDATE ${quote(patch.table)} SET ${quote(patch.column)} = $1 WHERE ${quote(patch.keyColumn)} = $2`,
            [patch.value, patch.key])
        }
        await target.query('COMMIT')
      }

      if (!options.dryRun) {
        const { rows: sourceMigrations } = await source.query('SELECT version FROM schema_migrations ORDER BY version')
        const { rows: targetMigrations } = await target.query('SELECT version FROM schema_migrations ORDER BY version')
        const targetVersions = new Set(targetMigrations.map((row) => row.version))
        const missing = sourceMigrations.map((row) => row.version).filter((version) => !targetVersions.has(version))
        if (missing.length) console.log(`\nWARNING: target is missing migrations ${missing.join(', ')}. Run npm run db:migrate.`)

        const finalCounts = await tableCounts(target, copyTables)
        const mismatched = copyTables.filter((table) => finalCounts[table] !== sourceCounts[table])
        if (mismatched.length) {
          console.log(`\nWARNING: row counts differ for ${mismatched.join(', ')} (source had extra conflicting keys).`)
        }
      }

      console.log(`\nCopied ${copiedTotal} row(s), skipped ${skippedTotal} existing row(s).`)
      if (options.dryRun) {
        console.log('Dry run: nothing was written. Re-run without --dry-run to copy.')
      } else {
        console.log('Next: move media bytes with MEDIA_DRIVER=s3 npm run media:backfill, then npm run media:verify.')
      }
    } catch (error) {
      if (!options.dryRun) await target.query('ROLLBACK').catch(() => {})
      throw error
    }
  } finally {
    await source.end().catch(() => {})
    await target.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error(`\nCopy failed: ${error.message}`)
  process.exit(1)
})
