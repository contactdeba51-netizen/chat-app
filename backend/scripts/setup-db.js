// Creates the chat_app database (if needed) and applies pending migrations.
// Usage: node scripts/setup-db.js
require('dotenv').config({ quiet: true })
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Client } = require('pg')

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured in backend/.env')

  const target = new URL(process.env.DATABASE_URL)
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''))
  if (!databaseName) throw new Error('DATABASE_URL must include a database name.')

  const adminUrl = new URL(target)
  adminUrl.pathname = '/postgres'

  const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  const admin = new Client({ connectionString: adminUrl.toString(), ssl })
  await admin.connect()
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName])
  if (existing.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`)
    console.log(`Created database ${databaseName}`)
  } else {
    console.log(`Database ${databaseName} already exists`)
  }
  await admin.end()

  execFileSync(process.execPath, [path.join(__dirname, 'migrate.js'), 'up'], { stdio: 'inherit', env: process.env })
}

main().catch((error) => {
  console.error('Database setup failed:', error.message)
  process.exit(1)
})
