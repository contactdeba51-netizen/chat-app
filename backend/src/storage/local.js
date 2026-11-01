// Local disk driver. Development and tests only: managed hosts such as Render
// have an ephemeral filesystem, so production media must live in R2.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const uploadDirectory = path.join(__dirname, '..', '..', 'uploads')
fs.mkdirSync(uploadDirectory, { recursive: true })

// Object keys end in the same UUID filename used by /uploads/<name> URLs, so a
// local object can be served by the existing media route.
function filePath(key) {
  const name = path.basename(String(key || ''))
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/i.test(name)) {
    throw new Error('Invalid local storage key.')
  }
  return path.join(uploadDirectory, name)
}

async function putObject({ key, body }) {
  await fsp.writeFile(filePath(key), body)
  return { provider: 'local', key, bucket: null }
}

async function deleteObject(key) {
  try {
    await fsp.unlink(filePath(key))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function exists(key) {
  try {
    await fsp.access(filePath(key))
    return true
  } catch {
    return false
  }
}

async function headObject(key) {
  const stat = await fsp.stat(filePath(key))
  return { byteSize: stat.size }
}

module.exports = {
  provider: 'local',
  uploadDirectory,
  filePath,
  putObject,
  deleteObject,
  exists,
  headObject,
}
