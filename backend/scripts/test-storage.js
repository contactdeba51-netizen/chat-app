// Round-trips a tiny object through the configured media driver. Useful before
// pointing production at managed object storage.
//
//   npm run storage:test
require('dotenv').config({ quiet: true })
const crypto = require('node:crypto')
const storage = require('../src/storage')

async function main() {
  const provider = storage.driverName()
  const driver = storage.driverFor(provider)
  if (storage.isRemote(provider) && !driver.isConfigured()) {
    const missing = typeof driver.missingSettings === 'function' ? driver.missingSettings().join(', ') : 'credentials'
    throw new Error(`MEDIA_DRIVER=${provider} but storage is not configured (missing ${missing}).`)
  }
  const key = `${storage.prefix()}/healthcheck/${crypto.randomUUID()}.txt`
  const body = Buffer.from(`chat-app storage check ${new Date().toISOString()}`)
  let ok = true

  console.log(`Driver: ${provider}${storage.bucketName() ? ` (bucket ${storage.bucketName()})` : ''}`)
  const stored = await storage.putObject({ key, body, contentType: 'text/plain' })
  console.log(`  put     ${stored.provider} ${key}`)

  const exists = await storage.exists({ provider, key })
  console.log(`  exists  ${exists}`)
  ok = ok && exists

  const url = await storage.readUrl({ provider, key })
  if (url) {
    const response = await fetch(url)
    const text = await response.text()
    console.log(`  signed  HTTP ${response.status} (${text.length} bytes)`)
    ok = ok && response.ok && text === body.toString()
  } else {
    console.log('  signed  not applicable for the local driver')
  }

  await storage.deleteObject({ provider, key })
  const gone = !(await storage.exists({ provider, key }))
  console.log(`  delete  ${gone ? 'removed' : 'STILL PRESENT'}`)
  ok = ok && gone

  await require('../src/db').pool.end().catch(() => {})
  if (!ok) {
    console.error('\nStorage check failed.')
    process.exit(1)
  }
  console.log('\nStorage check passed.')
}

main().catch((error) => {
  console.error(`\nStorage check failed: ${error.message}`)
  process.exit(1)
})
