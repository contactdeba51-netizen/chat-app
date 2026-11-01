// Storage selection. MEDIA_DRIVER picks where new uploads are written:
//   s3    -> any S3-compatible private bucket (Neon Object Storage, B2, ...)
//   r2    -> legacy Cloudflare R2 driver (kept so existing deployments work)
//   local -> backend/uploads (development only; Render's disk is ephemeral)
// MEDIA_FALLBACK=local mirrors writes to disk during a migration window.
const crypto = require('node:crypto')
const path = require('node:path')
const local = require('./local')
const r2 = require('./r2')
const s3 = require('./s3')

function driverName() {
  const value = String(process.env.MEDIA_DRIVER || process.env.STORAGE_DRIVER || 'local').toLowerCase()
  if (value === 's3' || value === 'b2' || value === 'neon') return 's3'
  if (value === 'r2') return 'r2'
  return 'local'
}

// Rows store the provider that actually holds the bytes, so reads must follow
// the row rather than the current configuration.
function driverFor(provider) {
  const name = String(provider || 'local').toLowerCase()
  if (name === 's3' || name === 'b2') return s3
  if (name === 'r2') return r2
  return local
}

function isRemote(provider) {
  return driverFor(provider) !== local
}

function fallbackName() {
  return String(process.env.MEDIA_FALLBACK || 'none').toLowerCase() === 'local' ? 'local' : 'none'
}

function activeDriver() {
  return driverFor(driverName())
}

function prefix() {
  return String(process.env.MEDIA_PREFIX || process.env.R2_PREFIX || 'prod').replace(/^\/+|\/+$/g, '')
}

function bucketName() {
  const name = driverName()
  if (name === 's3') return process.env.S3_BUCKET || null
  if (name === 'r2') return process.env.R2_BUCKET || null
  return null
}

function buildObjectKey(kind, extension) {
  const now = new Date()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${prefix()}/${kind}/${now.getUTCFullYear()}/${month}/${crypto.randomUUID()}.${extension}`
}

// The legacy /uploads URL is derived from the key's basename so every existing
// serializer, message pattern, and frontend path keeps working unchanged.
function fileNameFromKey(key) {
  return path.basename(String(key || ''))
}

async function putObject(options) {
  const stored = await activeDriver().putObject(options)
  if (driverName() !== 'local' && fallbackName() === 'local') {
    await local.putObject(options)
  }
  return stored
}

async function deleteObject({ provider, key }) {
  await driverFor(provider).deleteObject(key)
  // During dual-write the same key also exists on local disk.
  if (isRemote(provider) && fallbackName() === 'local') await local.deleteObject(key)
}

async function exists({ provider, key }) {
  return driverFor(provider).exists(key)
}

async function headObject({ provider, key }) {
  return driverFor(provider).headObject(key)
}

// Returns null for the local driver and for any provider that is not
// configured, so callers can fall back to a local copy instead of failing.
async function readUrl({ provider, key }) {
  const driver = driverFor(provider)
  if (driver === local || !driver.isConfigured?.()) return null
  if (typeof driver.stableSignedUrl === 'function') return driver.stableSignedUrl(key)
  if (typeof driver.signedUrl === 'function') return driver.signedUrl(key)
  return null
}

module.exports = {
  driverName,
  driverFor,
  isRemote,
  fallbackName,
  activeDriver,
  prefix,
  bucketName,
  buildObjectKey,
  fileNameFromKey,
  putObject,
  deleteObject,
  exists,
  headObject,
  readUrl,
  local,
  s3,
  r2,
}
