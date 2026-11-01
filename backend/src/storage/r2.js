// Cloudflare R2 driver (S3-compatible). The bucket stays private: reads are
// short-lived presigned GETs, handed out by the signed /api/media redirect.
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

const config = {
  accountId: process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
}

let client = null

function isConfigured() {
  return Boolean(config.accountId && config.accessKeyId && config.secretAccessKey && config.bucket)
}

function storageError(message) {
  const error = new Error(message)
  error.status = 503
  return error
}

function s3() {
  if (!isConfigured()) {
    throw storageError('Media storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET.')
  }
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    })
  }
  return client
}

function bucket() {
  if (!config.bucket) throw storageError('R2_BUCKET is not configured.')
  return config.bucket
}

async function putObject({ key, body, contentType }) {
  await s3().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'private, max-age=31536000, immutable',
  }))
  return { provider: 'r2', key, bucket: bucket() }
}

async function deleteObject(key) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
}

async function exists(key) {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
    return true
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return false
    throw error
  }
}

async function headObject(key) {
  const result = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
  return { byteSize: Number(result.ContentLength) || 0, contentType: result.ContentType }
}

// Short-lived by design. The chat-facing link keeps its 7-day lifetime and
// redirects here, so a leaked R2 URL expires in minutes and deleting the
// media row revokes the long-lived link.
async function signedUrl(key, expiresIn = Number(process.env.MEDIA_REDIRECT_TTL_SECONDS) || 300) {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn })
}

module.exports = {
  provider: 'r2',
  isConfigured,
  putObject,
  deleteObject,
  exists,
  headObject,
  signedUrl,
}
