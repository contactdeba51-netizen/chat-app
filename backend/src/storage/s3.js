// Generic S3-compatible driver. Works with Neon Object Storage, Backblaze B2,
// and any other path-style S3 endpoint. The bucket stays private: reads are
// short-lived presigned GETs behind the app-signed /api/media link.
//
// Configuration is read lazily so tests can change the environment after this
// module is required.
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_PRESIGN_SECONDS = 604800 // SigV4 upper bound: 7 days.
const CACHE_CONTROL = process.env.MEDIA_CACHE_CONTROL || 'private, max-age=604800, immutable'

// Neon documents 503 SlowDown under load; B2 and S3 throttle the same way.
// Retries are safe because every operation used here is idempotent.
const RETRYABLE_CODES = new Set([
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'RequestTimeout',
  'RequestTimeoutException',
  'InternalError',
  'ServiceUnavailable',
  'TimeoutError',
  'ECONNRESET',
  'EPIPE',
])
const MAX_ATTEMPTS = 4

function normalizeEndpoint(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

function config() {
  return {
    endpoint: normalizeEndpoint(process.env.S3_ENDPOINT),
    region: String(process.env.S3_REGION || 'auto').trim(),
    bucket: String(process.env.S3_BUCKET || '').trim(),
    accessKeyId: String(process.env.S3_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(process.env.S3_SECRET_ACCESS_KEY || '').trim(),
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE ?? 'true').toLowerCase() !== 'false',
  }
}

function isConfigured() {
  const current = config()
  return Boolean(current.endpoint && current.bucket && current.accessKeyId && current.secretAccessKey)
}

function missingSettings() {
  const current = config()
  return [
    ['S3_ENDPOINT', current.endpoint],
    ['S3_BUCKET', current.bucket],
    ['S3_ACCESS_KEY_ID', current.accessKeyId],
    ['S3_SECRET_ACCESS_KEY', current.secretAccessKey],
  ].filter(([, value]) => !value).map(([name]) => name)
}

function storageError(message) {
  const error = new Error(message)
  error.status = 503
  return error
}

let cached = { key: '', client: null }

function client() {
  const current = config()
  if (!isConfigured()) {
    throw storageError(`Media storage is not configured. Missing ${missingSettings().join(', ')}.`)
  }
  const key = JSON.stringify(current)
  if (!cached.client || cached.key !== key) {
    cached = {
      key,
      client: new S3Client({
        region: current.region,
        endpoint: current.endpoint,
        forcePathStyle: current.forcePathStyle,
        credentials: { accessKeyId: current.accessKeyId, secretAccessKey: current.secretAccessKey },
        maxAttempts: 1, // Retries are handled below with backoff.
      }),
    }
  }
  return cached.client
}

function bucket() {
  const current = config()
  if (!current.bucket) throw storageError('S3_BUCKET is not configured.')
  return current.bucket
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function send(command) {
  let lastError
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await client().send(command)
    } catch (error) {
      lastError = error
      const status = error?.$metadata?.httpStatusCode
      const code = error?.name || error?.Code
      const retryable = status === 429 || status === 500 || status === 503 || RETRYABLE_CODES.has(code)
      if (!retryable || attempt === MAX_ATTEMPTS) break
      // Exponential backoff with jitter so parallel requests do not resonate.
      await delay(150 * 2 ** (attempt - 1) + Math.floor(Math.random() * 120))
    }
  }
  const status = lastError?.$metadata?.httpStatusCode
  if (status === 403) throw storageError('Media storage rejected the request. Check the storage credentials.')
  if (lastError && !lastError.status) lastError.status = 503
  throw lastError
}

async function putObject({ key, body, contentType }) {
  await send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: CACHE_CONTROL,
  }))
  return { provider: 's3', key, bucket: bucket() }
}

async function deleteObject(key) {
  await send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
}

async function exists(key) {
  try {
    await send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
    return true
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return false
    throw error
  }
}

async function headObject(key) {
  const result = await send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
  return { byteSize: Number(result.ContentLength) || 0, contentType: result.ContentType }
}

// Plain presign, used by tooling that wants a short-lived link.
async function signedUrl(key, expiresIn = Number(process.env.MEDIA_REDIRECT_TTL_SECONDS) || 300) {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: Math.min(Math.max(Number(expiresIn) || 300, 1), MAX_PRESIGN_SECONDS),
  })
}

// Signing date is bucketed to the start of the UTC day, so every request in a
// day produces an identical URL. Object keys are immutable, so the browser can
// keep the bytes cached instead of downloading the same photo on every open.
async function stableSignedUrl(key) {
  const ttl = Math.min(Math.max(Number(process.env.MEDIA_SIGNED_URL_TTL_SECONDS) || MAX_PRESIGN_SECONDS, 60), MAX_PRESIGN_SECONDS)
  const dayStart = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS)
  // If the configured lifetime is shorter than the time already elapsed today,
  // signing from the day start would return an expired URL.
  const signingDate = Date.now() - dayStart.getTime() >= ttl * 1000 ? new Date() : dayStart
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: ttl,
    signingDate,
  })
}

module.exports = {
  provider: 's3',
  isConfigured,
  missingSettings,
  cacheControl: CACHE_CONTROL,
  putObject,
  deleteObject,
  exists,
  headObject,
  signedUrl,
  stableSignedUrl,
}
