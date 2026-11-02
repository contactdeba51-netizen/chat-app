import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FIXTURE_PATH } from './global-setup.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const backend = path.resolve(here, '../../../backend')
const require = createRequire(import.meta.url)

const dotenv = require(path.join(backend, 'node_modules/dotenv'))
dotenv.config({ path: path.join(backend, '.env'), quiet: true })
const { Client } = require(path.join(backend, 'node_modules/pg'))

// Deleting both accounts cascades to their chat, messages, receipts, and
// preferences, so a test run leaves the development database as it found it.
export default async function globalTeardown() {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query("DELETE FROM users WHERE email LIKE 'e2e.%@example.com'")
  } finally {
    await db.end()
    fs.rmSync(FIXTURE_PATH, { force: true })
  }
}
