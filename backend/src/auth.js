const crypto = require('node:crypto')
const jwt = require('jsonwebtoken')
const { query } = require('./db')

const JWT_SECRET = process.env.JWT_SECRET || 'replace-this-in-production'

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, ver: Number(user.token_version) || 0 }, JWT_SECRET, { expiresIn: '7d' })
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET)
}

function tokenFromRequest(request) {
  const header = request.headers.authorization || ''
  if (header.startsWith('Bearer ')) return header.slice(7)
  return request.cookies?.chat_access_token
}

// The version check lets a password reset invalidate every token issued before it.
async function requireAuth(request, response, next) {
  let payload
  try {
    const token = tokenFromRequest(request)
    if (!token) return response.status(401).json({ error: 'Authentication is required.' })
    payload = verifyAccessToken(token)
    const { rows } = await query('SELECT token_version FROM users WHERE id = $1', [payload.sub])
    if (!rows[0] || (Number(payload.ver) || 0) !== rows[0].token_version) {
      return response.status(401).json({ error: 'Your session has ended. Sign in again.' })
    }
  } catch {
    return response.status(401).json({ error: 'Your session is invalid or expired.' })
  }
  request.auth = payload
  next()
}

function createResetToken() {
  const token = crypto.randomBytes(32).toString('hex')
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  return { token, hash }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

module.exports = { signAccessToken, verifyAccessToken, requireAuth, createResetToken, hashToken }
