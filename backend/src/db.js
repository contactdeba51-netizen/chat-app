const { Pool } = require('pg')

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not configured. Database requests will fail until it is set.')
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'chat-app',
})

// A dropped backend connection must not take the process down; the pool
// replaces it on the next query.
pool.on('error', (error) => {
  console.error('Idle PostgreSQL client error:', error.message)
})

function query(text, values) {
  return pool.query(text, values)
}

async function transaction(callback) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

module.exports = { pool, query, transaction }
