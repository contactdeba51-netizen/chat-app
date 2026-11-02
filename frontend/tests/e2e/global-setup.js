import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const backend = path.resolve(here, '../../../backend')
const require = createRequire(import.meta.url)

const dotenv = require(path.join(backend, 'node_modules/dotenv'))
dotenv.config({ path: path.join(backend, '.env'), quiet: true })
const { Client } = require(path.join(backend, 'node_modules/pg'))
const bcrypt = require(path.join(backend, 'node_modules/bcryptjs'))

export const FIXTURE_PATH = path.join(here, '.users.json')
const PASSWORD = 'E2ePassword123!'

// Two real accounts and one direct chat. Signing up through the UI would need a
// delivered email code, so the accounts are seeded the same way the smoke suite
// does it and the tests exercise the real login form from there.
export default async function globalSetup() {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await db.query("DELETE FROM users WHERE email LIKE 'e2e.%@example.com'")

    const stamp = Date.now()
    const passwordHash = await bcrypt.hash(PASSWORD, 10)
    const create = async (tag, displayName) => {
      const email = `e2e.${tag}.${stamp}@example.com`
      const { rows } = await db.query(`INSERT INTO users (email, password_hash, display_name, email_verified_at)
        VALUES ($1, $2, $3, NOW()) RETURNING id`, [email, passwordHash, displayName])
      return { key: tag, email, displayName, id: rows[0].id }
    }

    const alice = await create('a', 'E2E Alice')
    const bob = await create('b', 'E2E Bob')
    const [first, second] = [alice.id, bob.id].sort()
    const { rows: chats } = await db.query(`INSERT INTO chats (type, user_one_id, user_two_id)
      VALUES ('direct', $1, $2) RETURNING id`, [first, second])

    fs.writeFileSync(FIXTURE_PATH, JSON.stringify({
      password: PASSWORD,
      chatId: chats[0].id,
      users: { a: alice, b: bob },
    }, null, 2))
  } finally {
    await db.end()
  }
}
