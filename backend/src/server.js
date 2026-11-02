require('dotenv').config()

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createServer } = require('node:http')
const bcrypt = require('bcryptjs')
const cookieParser = require('cookie-parser')
const cors = require('cors')
const express = require('express')
const rateLimit = require('express-rate-limit')
// ipKeyGenerator normalises IPv6 addresses to a /56 subnet so one client
// cannot rotate through billions of addresses to dodge a limit.
const { ipKeyGenerator } = rateLimit
const helmet = require('helmet')
const multer = require('multer')
const { Server } = require('socket.io')
const { z } = require('zod')
const { query, transaction } = require('./db')
const media = require('./media')
const storage = require('./storage')
const { signAccessToken, verifyAccessToken, requireAuth, createResetToken, hashToken } = require('./auth')
const { sendMail, isConfigured: mailConfigured } = require('./mailer')
const { normalizePhone, formatPhone, isCountryCode } = require('./phone')
const { jwtSecret, mediaSecret, assertProductionSecrets } = require('./secrets')

const PORT = Number(process.env.PORT) || 5000
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173'
const isProduction = process.env.NODE_ENV === 'production'
// The client may run on any localhost port (Vite picks 5174, 5175, ... when 5173 is busy).
const allowedOrigins = new Set([CLIENT_URL, ...String(process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)])
function corsOrigin(origin, callback) {
  const localPreview = !isProduction && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin || '')
  return callback(null, !origin || allowedOrigins.has(origin) || localPreview)
}
// A production deployment must not start with a missing, short, or shared
// secret: those values sign sessions, media links, and chat unlock tokens.
assertProductionSecrets()
if (!isProduction && !process.env.JWT_SECRET) console.warn('JWT_SECRET is not configured. Using the development fallback; production requires a real secret.')
if (!mailConfigured()) console.warn('Email delivery is not configured. Sign-ups and password recovery stay disabled until BREVO_API_KEY and EMAIL_FROM are set.')
if (isProduction && storage.driverName() === 'local') console.warn('MEDIA_DRIVER is "local". Render disks are ephemeral, so uploaded media will be lost on the next deploy.')
if (storage.driverName() === 's3' && !storage.s3.isConfigured()) console.warn(`MEDIA_DRIVER=s3 but storage credentials are incomplete (${storage.s3.missingSettings().join(', ')}). Uploads will fail with 503.`)
if (storage.driverName() === 'r2' && !storage.r2.isConfigured()) console.warn('MEDIA_DRIVER=r2 but R2 credentials are incomplete. Uploads will fail with 503.')
const app = express()
// Render terminates TLS at its proxy. Without this every request appears to
// come from the proxy address, which would make the per-IP limits throttle
// all users at once. Set TRUST_PROXY_HOPS=0 to disable.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 1)
if (isProduction && trustProxyHops > 0) app.set('trust proxy', trustProxyHops)
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: corsOrigin, credentials: true, methods: ['GET', 'POST'] } })
const onlineUsers = new Map()

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({ origin: corsOrigin, credentials: true }))
app.use(express.json({ limit: '10mb' }))
app.use(cookieParser())

const uploadDirectory = path.join(__dirname, '..', 'uploads')
// Uploads land in a scratch folder first; they only get a permanent name after
// the bytes have been validated and normalised.
const uploadTempDirectory = path.join(uploadDirectory, '.tmp')
fs.mkdirSync(uploadTempDirectory, { recursive: true })

// Media is never served from a public directory. Every stored file gets a
// short-lived signed URL, so only people who received the link can fetch it.
const MEDIA_SECRET = mediaSecret()
const MEDIA_URL_TTL_SECONDS = Number(process.env.MEDIA_URL_TTL_SECONDS) || 7 * 24 * 60 * 60
const MEDIA_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/

function mediaSignature(filename, expires) {
  return crypto.createHmac('sha256', MEDIA_SECRET).update(`${filename}:${expires}`).digest()
}

function signMediaPath(filename) {
  const expires = Math.floor(Date.now() / 1000) + MEDIA_URL_TTL_SECONDS
  return `/api/media/${filename}?expires=${expires}&signature=${mediaSignature(filename, expires).toString('hex')}`
}

// Stored values look like /uploads/<uuid>.<ext>. Anything else (legacy data or
// external URLs) is returned untouched so old rows still render.
function publicMediaUrl(storedUrl) {
  const match = /^\/uploads\/([^/]+)$/.exec(String(storedUrl || ''))
  return match && MEDIA_FILE_PATTERN.test(match[1]) ? signMediaPath(match[1]) : storedUrl
}

function storedFilename(storedUrl) {
  const match = /^\/uploads\/([^/]+)$/.exec(String(storedUrl || ''))
  return match && MEDIA_FILE_PATTERN.test(match[1]) ? match[1] : null
}

// Removes bytes only when no message, status, avatar, or chat still references
// them, so forwarding a photo does not break the original.
const deleteStoredFile = (storedUrl) => media.deleteStoredFile(storedUrl)

app.get('/api/media/:filename', asyncRoute(async (request, response) => {
  const { filename } = request.params
  if (!MEDIA_FILE_PATTERN.test(filename)) return response.status(404).end()
  const expires = Number(request.query.expires)
  const signature = String(request.query.signature || '')
  if (!Number.isFinite(expires) || expires * 1000 < Date.now() || !/^[a-f0-9]{64}$/.test(signature)) {
    return response.status(403).json({ error: 'This media link has expired.' })
  }
  const expected = mediaSignature(filename, expires)
  const provided = Buffer.from(signature, 'hex')
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return response.status(403).json({ error: 'This media link is invalid.' })
  }

  const object = await media.getMediaByUrl(`/uploads/${filename}`)
  if (object?.deleted_at) return response.status(410).json({ error: 'This media is no longer available.' })

  // Never let a browser reinterpret the payload; the stored MIME type is the
  // one validated at upload time.
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Content-Security-Policy', "default-src 'none'")
  if (object) response.setHeader('Content-Type', object.mime_type)

  if (object && storage.isRemote(object.storage_provider)) {
    // The chat-facing link lives for 7 days, but this redirect is re-checked
    // on every request so deleting the media row revokes access immediately.
    // The presigned target is stable for the whole UTC day, which lets the
    // browser keep the bytes cached instead of downloading them again.
    const signed = await storage.readUrl({ provider: object.storage_provider, key: object.object_key })
    if (signed) {
      response.setHeader('Cache-Control', 'no-store')
      return response.redirect(302, signed)
    }
    // Misconfigured remote storage still serves from the local mirror below.
  }

  response.setHeader('Cache-Control', 'private, max-age=3600')
  response.sendFile(filename, { root: uploadDirectory }, (error) => {
    if (error && !response.headersSent) response.status(404).json({ error: 'Media not found.' })
  })
}))
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadTempDirectory,
    filename: (_request, file, done) => done(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase() || '.bin'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_request, file, done) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) return done(null, true)
    const error = new Error('Use a JPEG, PNG, WebP, or GIF image up to 5 MB.')
    error.status = 400
    done(error)
  },
})

const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: uploadTempDirectory,
    filename: (_request, file, done) => done(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase() || '.bin'}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_request, file, done) => {
    if (/^(image|video)\/(jpeg|png|webp|gif|mp4|webm|quicktime)$/.test(file.mimetype)) return done(null, true)
    const error = new Error('Use a JPEG, PNG, WebP, GIF, MP4, WebM, or MOV file up to 25 MB.')
    error.status = 400
    done(error)
  },
})

// Validates the real bytes, re-encodes images, enforces quotas, and removes
// the scratch file whether or not the upload succeeds.
async function handleUpload(request, kind) {
  const file = request.file
  if (!file) return null
  try {
    const buffer = await fs.promises.readFile(file.path)
    const processed = await media.processUpload({ buffer, kind })
    return await media.storeUpload({ userId: request.auth.sub, kind, processed })
  } finally {
    await fs.promises.unlink(file.path).catch(() => {})
  }
}

// Limits are generous by default because local testing runs many logins from one IP;
// override with LOGIN_RATE_LIMIT / CODE_RATE_LIMIT in .env when deploying.
// (backend/.env raises these locally so the smoke suite can run repeatedly.)
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.LOGIN_RATE_LIMIT) || 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again in 15 minutes.' } })
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many reset requests. Try again later.' } })
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-up attempts. Try again later.' } })
const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.CODE_RATE_LIMIT) || 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many code attempts. Try again in 15 minutes.' } })
const inviteLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many invitations. Try again later.' } })
// Write limits are keyed by account, not IP, so shared connections do not punish each other.
const messageLimiter = rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.MESSAGE_RATE_LIMIT) || 90, standardHeaders: true, legacyHeaders: false, keyGenerator: (request) => request.auth?.sub || ipKeyGenerator(request.ip), message: { error: 'You are sending messages too quickly. Slow down for a moment.' } })
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: Number(process.env.UPLOAD_RATE_LIMIT) || 40, standardHeaders: true, legacyHeaders: false, keyGenerator: (request) => request.auth?.sub || ipKeyGenerator(request.ip), message: { error: 'Too many uploads. Try again later.' } })
// A second budget keyed by IP catches many-account abuse from one connection.
const uploadIpLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: Number(process.env.UPLOAD_IP_RATE_LIMIT) || 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many uploads from this connection. Try again later.' } })
const statusLimiter = rateLimit({ windowMs: 24 * 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: (request) => request.auth?.sub || ipKeyGenerator(request.ip), message: { error: 'You have posted enough status updates for today.' } })

// Socket messages skip Express, so they get the same budget in memory.
const socketMessageTimes = new Map()
function allowSocketMessage(userId) {
  const now = Date.now()
  const times = (socketMessageTimes.get(userId) || []).filter((time) => time > now - 60_000)
  if (times.length >= 60) { socketMessageTimes.set(userId, times); return false }
  times.push(now)
  socketMessageTimes.set(userId, times)
  return true
}

const signupStartSchema = z.object({
  country: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  phone: z.string().trim().min(4).max(24),
  displayName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
})
const signupVerifySchema = z.object({ pendingId: z.string().uuid(), code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your email.') })
const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(254).optional(),
  email: z.string().trim().max(254).optional(),
  country: z.string().trim().length(2).optional(),
  password: z.string().min(1).max(128),
}).refine((value) => value.identifier || value.email, { message: 'Enter your phone number or email address.' })
const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  bio: z.string().trim().max(500).optional(),
  phone: z.string().trim().min(4).max(24).optional(),
  country: z.string().trim().length(2).optional(),
})
const privacySchema = z.object({
  presenceVisible: z.boolean().optional(),
  lastSeenVisible: z.boolean().optional(),
  contactPermission: z.enum(['everyone', 'contacts', 'nobody']).optional(),
  findableByPhone: z.boolean().optional(),
})

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next)
}

function parse(schema, input) {
  const result = schema.safeParse(input)
  if (!result.success) {
    const error = new Error(result.error.issues[0].message)
    error.status = 400
    throw error
  }
  return result.data
}

function colorFor(id) {
  const colors = ['#357c75', '#7b61a8', '#c46c87', '#d9a441', '#597d90']
  return colors[[...String(id)].reduce((total, character) => total + character.charCodeAt(0), 0) % colors.length]
}

function initials(name) {
  return String(name || '?').split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase()
}

function serializeUser(user, viewerId) {
  const showPresence = viewerId === user.id || user.presence_visible
  const showLastSeen = viewerId === user.id || user.last_seen_visible
  const isSelf = viewerId === user.id
  return {
    id: user.id,
    email: isSelf ? user.email : undefined,
    emailVerified: isSelf ? Boolean(user.email_verified_at) : undefined,
    phone: isSelf ? formatPhone(user.phone) : undefined,
    phoneCountry: isSelf ? user.phone_country : undefined,
    displayName: user.display_name,
    bio: user.bio,
    avatarUrl: publicMediaUrl(user.avatar_url),
    avatar: initials(user.display_name),
    color: colorFor(user.id),
    online: showPresence ? onlineUsers.has(user.id) : false,
    lastSeenAt: showLastSeen ? user.last_seen_at : null,
    privacy: isSelf ? { presenceVisible: user.presence_visible, lastSeenVisible: user.last_seen_visible, contactPermission: user.contact_permission, findableByPhone: user.findable_by_phone !== false } : undefined,
  }
}

async function getUser(userId) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [userId])
  return rows[0]
}

function setAuthCookie(response, token) {
  response.cookie('chat_access_token', token, { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' })
}

async function authResponse(response, user) {
  const token = signAccessToken(user)
  setAuthCookie(response, token)
  response.json({ token, user: serializeUser(user, user.id) })
}

async function isBlocked(userId, otherUserId) {
  const { rowCount } = await query('SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [userId, otherUserId])
  return rowCount > 0
}

async function ensureChatMember(chatId, userId) {
  const { rows } = await query(`SELECT c.* FROM chats c WHERE c.id = $1 AND (
      (c.type = 'direct' AND ($2 = c.user_one_id OR $2 = c.user_two_id))
      OR (c.type = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.chat_id = c.id AND gm.user_id = $2))
    )`, [chatId, userId])
  if (!rows[0]) {
    const error = new Error('Chat not found.')
    error.status = 404
    throw error
  }
  return rows[0]
}

async function chatMemberIds(chat) {
  if (chat.type !== 'group') return [chat.user_one_id, chat.user_two_id].filter(Boolean)
  const { rows } = await query('SELECT user_id FROM group_members WHERE chat_id = $1', [chat.id])
  return rows.map((row) => row.user_id)
}

// Direct chats are unique per pair; the database enforces it with a partial index.
async function getOrCreateDirectChat(one, two) {
  const [first, second] = [one, two].sort()
  const { rows: existing } = await query(`SELECT * FROM chats WHERE type = 'direct'
    AND user_one_id = $1 AND user_two_id = $2`, [first, second])
  if (existing[0]) return existing[0]
  try {
    const { rows } = await query(`INSERT INTO chats (type, user_one_id, user_two_id) VALUES ('direct', $1, $2) RETURNING *`, [first, second])
    return rows[0]
  } catch (error) {
    if (error.code !== '23505') throw error
    const { rows } = await query(`SELECT * FROM chats WHERE type = 'direct' AND user_one_id = $1 AND user_two_id = $2`, [first, second])
    return rows[0]
  }
}

// Locked chats are gated by a short-lived, per-user token. The PIN itself never
// leaves the server: only its bcrypt hash is stored.
const UNLOCK_TTL_SECONDS = 15 * 60

function unlockToken(chatId, userId) {
  const expires = Math.floor(Date.now() / 1000) + UNLOCK_TTL_SECONDS
  const signature = crypto.createHmac('sha256', MEDIA_SECRET).update(`unlock:${chatId}:${userId}:${expires}`).digest('hex')
  return `${expires}.${signature}`
}

function unlockTokenValid(chatId, userId, token) {
  const [expires, signature] = String(token || '').split('.')
  if (!/^\d+$/.test(String(expires)) || !/^[a-f0-9]{64}$/.test(String(signature))) return false
  if (Number(expires) * 1000 < Date.now()) return false
  const expected = crypto.createHmac('sha256', MEDIA_SECRET).update(`unlock:${chatId}:${userId}:${expires}`).digest()
  const provided = Buffer.from(signature, 'hex')
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
}

async function chatLockState(chatId, userId) {
  const { rows } = await query('SELECT locked, lock_pin_hash FROM chat_preferences WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  return rows[0] || { locked: false, lock_pin_hash: null }
}

async function requireChatAccess(chatId, userId, token) {
  const state = await chatLockState(chatId, userId)
  if (state.locked && !unlockTokenValid(chatId, userId, token)) {
    const error = new Error('This chat is locked. Enter your PIN to view it.')
    error.status = 403
    error.code = 'CHAT_LOCKED'
    throw error
  }
}

async function canContact(senderId, recipientId) {
  if (await isBlocked(senderId, recipientId)) return { allowed: false, reason: 'Messaging is unavailable for this user.' }
  const recipient = await getUser(recipientId)
  if (!recipient) return { allowed: false, reason: 'User not found.' }
  if (recipient.contact_permission === 'nobody') return { allowed: false, reason: 'This user does not accept new chats.' }
  if (recipient.contact_permission === 'contacts') {
    const { rowCount } = await query(`SELECT 1 FROM chats WHERE type = 'direct' AND ((user_one_id = $1 AND user_two_id = $2) OR (user_one_id = $2 AND user_two_id = $1))
      UNION SELECT 1 FROM contacts WHERE (owner_id = $2 AND contact_id = $1) OR (owner_id = $1 AND contact_id = $2)`, [senderId, recipientId])
    if (!rowCount) return { allowed: false, reason: 'This user accepts messages from existing contacts only.' }
  }
  return { allowed: true }
}

const MESSAGE_SELECT = `
  SELECT m.*, sender.display_name AS sender_name, sender.avatar_url AS sender_avatar,
    reply.body AS reply_body, reply.sender_id AS reply_sender_id,
    COALESCE((SELECT json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id, 'displayName', ru.display_name))
      FROM message_reactions r JOIN users ru ON ru.id = r.user_id WHERE r.message_id = m.id), '[]') AS reactions,
    (SELECT delivered_at FROM message_receipts mr WHERE mr.message_id = m.id AND mr.user_id <> m.sender_id LIMIT 1) AS delivered_at,
    (SELECT read_at FROM message_receipts mr WHERE mr.message_id = m.id AND mr.user_id <> m.sender_id LIMIT 1) AS read_at,
    EXISTS (SELECT 1 FROM message_stars ms WHERE ms.message_id = m.id AND ms.user_id = $2) AS starred
  FROM messages m JOIN users sender ON sender.id = m.sender_id
  LEFT JOIN messages reply ON reply.id = m.reply_to_id`

function mapMessage(message, viewerId) {
  if (!message) return null
  return {
    id: message.id, chatId: message.chat_id, senderId: message.sender_id, senderName: message.sender_name,
    senderAvatar: publicMediaUrl(message.sender_avatar), text: message.deleted_at ? 'This message was deleted.' : message.body,
    image: publicMediaUrl(message.media_url), sticker: message.sticker, replyTo: message.reply_to_id ? { id: message.reply_to_id, text: message.reply_body, senderId: message.reply_sender_id } : null,
    forwarded: Boolean(message.forwarded_from_id), reactions: message.reactions, createdAt: message.created_at,
    editedAt: message.edited_at, deletedAt: message.deleted_at, deliveredAt: message.delivered_at, readAt: message.read_at,
    mine: message.sender_id === viewerId, starred: Boolean(message.starred),
  }
}

// One query for any number of messages, so chat lists and search stop issuing
// one query per message.
async function loadMessages(messageIds, viewerId) {
  if (!messageIds.length) return []
  const { rows } = await query(`${MESSAGE_SELECT} WHERE m.id = ANY($1::uuid[])
    ORDER BY m.created_at ASC, m.id ASC`, [messageIds, viewerId])
  return rows.map((row) => mapMessage(row, viewerId))
}

async function loadMessage(messageId, viewerId) {
  const [message] = await loadMessages([messageId], viewerId)
  return message || null
}

// Newest messages first in SQL, then reversed for display. `before` is an ISO
// timestamp used as a cursor for loading older history.
async function getChatMessages(chatId, viewerId, limit = 100, before = null) {
  await ensureChatMember(chatId, viewerId)
  const params = [chatId, limit]
  let cursor = ''
  if (before) { params.push(before); cursor = ' AND created_at < $3' }
  const { rows } = await query(`SELECT id FROM messages WHERE chat_id = $1${cursor}
    ORDER BY created_at DESC, id DESC LIMIT $2`, params)
  return loadMessages(rows.reverse().map((row) => row.id), viewerId)
}

// Delivery is recorded when the recipient's device actually receives the
// message, never as a side effect of loading a chat list.
async function markChatDelivered(chatId, userId) {
  const { rows } = await query(`INSERT INTO message_receipts (message_id, user_id, delivered_at)
    SELECT id, $2, NOW() FROM messages WHERE chat_id = $1 AND sender_id <> $2
      AND NOT EXISTS (SELECT 1 FROM chat_preferences p WHERE p.chat_id = $1 AND p.user_id = $2 AND p.locked)
    ON CONFLICT (message_id, user_id) DO UPDATE SET delivered_at = EXCLUDED.delivered_at
      WHERE message_receipts.delivered_at IS NULL
    RETURNING message_id`, [chatId, userId])
  if (rows.length) io.to(roomFor(chatId)).emit('chat:delivered', { chatId, userId })
  return rows.length
}

async function markAllDelivered(userId) {
  const { rows } = await query(`INSERT INTO message_receipts (message_id, user_id, delivered_at)
    SELECT m.id, $1, NOW() FROM messages m JOIN chats c ON c.id = m.chat_id
    WHERE m.sender_id <> $1 AND (
      (c.type = 'direct' AND (c.user_one_id = $1 OR c.user_two_id = $1))
      OR (c.type = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.chat_id = c.id AND gm.user_id = $1))
    )
      AND NOT EXISTS (SELECT 1 FROM chat_preferences p WHERE p.chat_id = m.chat_id AND p.user_id = $1 AND p.locked)
    ON CONFLICT (message_id, user_id) DO UPDATE SET delivered_at = EXCLUDED.delivered_at
      WHERE message_receipts.delivered_at IS NULL
    RETURNING (SELECT chat_id FROM messages WHERE id = message_receipts.message_id) AS chat_id`, [userId])
  const chatIds = [...new Set(rows.map((row) => row.chat_id))]
  for (const chatId of chatIds) io.to(roomFor(chatId)).emit('chat:delivered', { chatId, userId })
}

// Builds chat summaries for any number of chats with a fixed number of queries:
// users, preferences, last-message/unread, the newest 100 message ids per chat,
// and then the full message rows. Previously this was O(chats x messages).
async function serializeChats(chatRows, viewerId) {
  if (!chatRows.length) return []
  const chatIds = chatRows.map((chat) => chat.id)
  const directRows = chatRows.filter((chat) => chat.type !== 'group')
  const otherIds = directRows.map((chat) => (chat.user_one_id === viewerId ? chat.user_two_id : chat.user_one_id)).filter(Boolean)

  const [usersResult, preferencesResult, summariesResult, windowResult, membersResult] = await Promise.all([
    query('SELECT * FROM users WHERE id = ANY($1::uuid[])', [otherIds]),
    query('SELECT chat_id, archived, locked FROM chat_preferences WHERE user_id = $1 AND chat_id = ANY($2::uuid[])', [viewerId, chatIds]),
    query(`SELECT c.id AS chat_id,
        (SELECT row_to_json(x) FROM (SELECT m.body, m.media_url, m.sticker, m.created_at, m.sender_id,
            (SELECT display_name FROM users u WHERE u.id = m.sender_id) AS sender_name
          FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) x) AS last,
        (SELECT COUNT(*)::int FROM messages m
          LEFT JOIN message_receipts r ON r.message_id = m.id AND r.user_id = $2
          WHERE m.chat_id = c.id AND m.sender_id <> $2 AND r.read_at IS NULL) AS unread
      FROM chats c WHERE c.id = ANY($1::uuid[])`, [chatIds, viewerId]),
    query(`SELECT id FROM (
        SELECT m.id, ROW_NUMBER() OVER (PARTITION BY m.chat_id ORDER BY m.created_at DESC, m.id DESC) AS position
        FROM messages m WHERE m.chat_id = ANY($1::uuid[])
      ) windowed WHERE position <= 100`, [chatIds]),
    query('SELECT chat_id, COUNT(*)::int AS member_count FROM group_members WHERE chat_id = ANY($1::uuid[]) GROUP BY chat_id', [chatIds]),
  ])

  const messages = await loadMessages(windowResult.rows.map((row) => row.id), viewerId)
  const usersById = new Map(usersResult.rows.map((user) => [user.id, user]))
  const preferencesByChat = new Map(preferencesResult.rows.map((preference) => [preference.chat_id, preference]))
  const summariesByChat = new Map(summariesResult.rows.map((summary) => [summary.chat_id, summary]))
  const memberCountsByChat = new Map(membersResult.rows.map((row) => [row.chat_id, row.member_count]))
  const messagesByChat = new Map()
  for (const message of messages) {
    const list = messagesByChat.get(message.chatId) || []
    list.push(message)
    messagesByChat.set(message.chatId, list)
  }

  return chatRows.map((chat) => {
    const isGroup = chat.type === 'group'
    const otherId = isGroup ? null : chat.user_one_id === viewerId ? chat.user_two_id : chat.user_one_id
    const otherUser = usersById.get(otherId)
    const preference = preferencesByChat.get(chat.id) || { archived: false, locked: false }
    const summary = summariesByChat.get(chat.id)
    const last = summary?.last
    const displayName = isGroup ? chat.name || 'Group' : otherUser?.display_name || 'Unknown user'
    const preview = !last ? 'Start a conversation' : last.sticker ? 'Sticker' : last.media_url ? 'Photo' : last.body
    const previewPrefix = !last ? '' : isGroup
      ? `${last.sender_id === viewerId ? 'You' : last.sender_name || 'Someone'}: `
      : last.sender_id === viewerId ? 'You: ' : ''
    return {
      id: chat.id, name: displayName, avatar: initials(displayName),
      avatarUrl: publicMediaUrl(isGroup ? chat.avatar_url : otherUser?.avatar_url), color: colorFor(isGroup ? chat.id : otherUser?.id || otherId),
      online: !isGroup && Boolean(otherUser?.presence_visible && onlineUsers.has(otherId)),
      lastSeenAt: isGroup ? null : otherUser?.last_seen_visible ? otherUser.last_seen_at : null,
      group: isGroup, memberCount: isGroup ? memberCountsByChat.get(chat.id) || 0 : undefined,
      // A locked chat hides its content until the owner unlocks it, so neither
      // the message list nor its preview leaves the server.
      lastMessage: preference.locked ? 'Locked chat' : last ? `${previewPrefix}${preview}` : preview,
      time: last?.created_at || chat.updated_at, unread: summary?.unread || 0,
      archived: preference.archived, locked: preference.locked,
      messages: preference.locked ? [] : messagesByChat.get(chat.id) || [], otherUserId: otherId,
    }
  })
}

async function serializeChat(chatRow, viewerId) {
  const [chat] = await serializeChats([chatRow], viewerId)
  return chat
}

async function getChatsForUser(userId) {
  const { rows } = await query(`SELECT c.* FROM chats c WHERE
      (c.type = 'direct' AND (c.user_one_id = $1 OR c.user_two_id = $1))
      OR (c.type = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.chat_id = c.id AND gm.user_id = $1))
    ORDER BY c.updated_at DESC`, [userId])
  return serializeChats(rows, userId)
}

async function createMessage({ chatId, senderId, text, image, sticker, replyToId, forwardedFromId }) {
  const chat = await ensureChatMember(chatId, senderId)
  const members = await chatMemberIds(chat)
  const recipients = members.filter((id) => id && id !== senderId)
  if (chat.type !== 'group' && recipients[0] && await isBlocked(senderId, recipients[0])) {
    const error = new Error('Messaging is unavailable for this user.')
    error.status = 403
    throw error
  }
  const body = String(text || '').trim()
  if (!body && !image && !sticker) { const error = new Error('A message cannot be empty.'); error.status = 400; throw error }
  if (image && !/^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif)$/i.test(String(image))) {
    const error = new Error('Attach photos with the upload button.')
    error.status = 400
    throw error
  }
  let mediaId = null
  if (image) {
    const attached = await media.assertMediaUsable(image, senderId, 'chat')
    mediaId = attached?.id || null
  }
  const { rows } = await query(`INSERT INTO messages (chat_id, sender_id, body, media_url, media_id, sticker, reply_to_id, forwarded_from_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [chatId, senderId, body, image || null, mediaId, sticker || null, replyToId || null, forwardedFromId || null])
  await query('UPDATE chats SET updated_at = NOW() WHERE id = $1', [chatId])
  const onlineRecipients = recipients.filter((id) => onlineUsers.has(id))
  await Promise.all(onlineRecipients.map((id) => markChatDelivered(chatId, id)))
  return loadMessage(rows[0].id, senderId)
}

function roomFor(chatId) { return `chat:${chatId}` }

// Presence is only shared with people the user actually knows: direct chat
// partners, group co-members, and saved contacts (in either direction).
async function presenceAudience(userId) {
  const { rows } = await query(`SELECT DISTINCT other AS id FROM (
      SELECT CASE WHEN user_one_id = $1 THEN user_two_id ELSE user_one_id END AS other
        FROM chats WHERE type = 'direct' AND (user_one_id = $1 OR user_two_id = $1)
      UNION SELECT gm2.user_id AS other FROM group_members gm1
        JOIN group_members gm2 ON gm2.chat_id = gm1.chat_id WHERE gm1.user_id = $1
      UNION SELECT contact_id AS other FROM contacts WHERE owner_id = $1 AND contact_id IS NOT NULL
      UNION SELECT owner_id AS other FROM contacts WHERE contact_id = $1
    ) audience WHERE other IS NOT NULL AND other <> $1`, [userId])
  return rows.map((row) => row.id)
}

async function broadcastPresence(userId, { online, lastSeenAt, notify = false }) {  try {
    const { rows } = await query('SELECT presence_visible, last_seen_visible FROM users WHERE id = $1', [userId])
    const user = rows[0]
    if (!user) return
    const audience = await presenceAudience(userId)
    if (!user.presence_visible) {
      // Only an explicit privacy change corrects a partner who still sees them online;
      // connect/disconnect events are suppressed entirely while hidden.
      if (notify) for (const id of audience) io.to(`user:${id}`).emit('presence:update', { userId, online: false })
      return
    }
    const event = { userId, online }
    if (!online && user.last_seen_visible) event.lastSeenAt = lastSeenAt
    for (const id of [userId, ...audience]) io.to(`user:${id}`).emit('presence:update', event)
  } catch (error) {
    console.error('Presence broadcast failed:', error.message)
  }
}

// Status updates follow the same visibility rule as the status list: the
// author, saved contacts, direct-chat partners, and group co-members, but
// never anyone on either side of a block.
async function statusAudience(userId) {
  const { rows } = await query(`SELECT DISTINCT other AS id FROM (
      SELECT $1::uuid AS other
      UNION SELECT CASE WHEN user_one_id = $1 THEN user_two_id ELSE user_one_id END
        FROM chats WHERE type = 'direct' AND (user_one_id = $1 OR user_two_id = $1)
      UNION SELECT gm2.user_id FROM group_members gm1
        JOIN group_members gm2 ON gm2.chat_id = gm1.chat_id WHERE gm1.user_id = $1
      UNION SELECT contact_id FROM contacts WHERE owner_id = $1 AND contact_id IS NOT NULL
      UNION SELECT owner_id FROM contacts WHERE contact_id = $1
    ) audience WHERE other IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blocks b
      WHERE (b.blocker_id = $1 AND b.blocked_id = other) OR (b.blocker_id = other AND b.blocked_id = $1))`, [userId])
  return rows.map((row) => row.id)
}

// Profile changes reach every open tab that can already see this person.
async function broadcastUserUpdate(userId) {
  try {
    const user = await getUser(userId)
    if (!user) return
    const payload = {
      userId,
      displayName: user.display_name,
      avatar: initials(user.display_name),
      color: colorFor(user.id),
      avatarUrl: publicMediaUrl(user.avatar_url),
    }
    const audience = await statusAudience(userId)
    for (const id of new Set([userId, ...audience])) io.to(`user:${id}`).emit('user:updated', payload)
  } catch (error) {
    console.error('Profile update broadcast failed:', error.message)
  }
}

function hashSignupCode(pendingId, code) {
  return crypto.createHmac('sha256', jwtSecret()).update(`${pendingId}:${code}`).digest('hex')
}

async function issueSignupCode(pending) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  await query(`UPDATE pending_signups SET code_hash = $1, attempts = 0, expires_at = NOW() + INTERVAL '10 minutes', last_sent_at = NOW() WHERE id = $2`, [hashSignupCode(pending.id, code), pending.id])
  await sendMail({
    to: pending.email,
    subject: 'Your Chat App verification code',
    text: `Your Chat App verification code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2a37;line-height:1.6">
      <h2 style="margin:0 0 12px">Verify your Chat App account</h2>
      <p style="margin:0 0 16px">Enter this code to finish creating your account:</p>
      <p style="margin:0 0 16px;font-size:30px;letter-spacing:8px;font-weight:700;color:#0f766e">${code}</p>
      <p style="margin:0;color:#5b6573;font-size:13px">The code expires in 10 minutes. If you did not request this, you can ignore this email.</p>
    </div>`,
  })
}

async function deliverPendingInvites(userId) {
  const user = await getUser(userId)
  if (!user?.phone) return
  const { rows: invites } = await query(`SELECT i.id, i.inviter_id, inviter.display_name AS inviter_name
    FROM phone_invites i JOIN users inviter ON inviter.id = i.inviter_id
    WHERE i.phone = $1 AND i.consumed_at IS NULL`, [user.phone])
  for (const invite of invites) {
    await query('UPDATE phone_invites SET consumed_at = NOW() WHERE id = $1', [invite.id])
    if (invite.inviter_id === userId || (await isBlocked(invite.inviter_id, userId))) continue
    const [one, two] = [invite.inviter_id, userId].sort()
    const chat = await getOrCreateDirectChat(one, two)
    const { rowCount } = await query('SELECT 1 FROM messages WHERE chat_id = $1 AND sender_id = $2', [chat.id, invite.inviter_id])
    if (!rowCount) {
      await query('INSERT INTO messages (chat_id, sender_id, body) VALUES ($1, $2, $3)',
        [chat.id, invite.inviter_id, `Hi! I'm ${invite.inviter_name}. I added you on Chat App — say hello 👋`])
      await query('UPDATE chats SET updated_at = NOW() WHERE id = $1', [chat.id])
    }
    io.to(`user:${invite.inviter_id}`).emit('chat:new', await serializeChat(chat, invite.inviter_id))
  }
  await query('UPDATE contacts SET contact_id = $1 WHERE phone = $2 AND contact_id IS NULL', [userId, user.phone])
}

async function findUserByPhone(phone) {
  const { rows } = await query('SELECT * FROM users WHERE phone = $1', [phone])
  return rows[0]
}

app.get('/api/health', (_request, response) => response.json({ status: 'ok' }))

// Liveness probe for uptime monitors. It deliberately does not touch
// PostgreSQL: Neon's free plan bills compute while the database is awake, so a
// ping every few minutes would keep it running around the clock.
app.get('/healthz', (_request, response) => response.json({ status: 'ok' }))

// Readiness probe for deploys and debugging. This one does hit the database.
app.get('/readyz', asyncRoute(async (_request, response) => {
  const { rows } = await query('SELECT 1 AS ok')
  response.json({ status: rows[0]?.ok === 1 ? 'ready' : 'unknown' })
}))

app.post('/api/auth/register/start', signupLimiter, asyncRoute(async (request, response) => {
  const input = parse(signupStartSchema, request.body)
  if (!isCountryCode(input.country)) return response.status(400).json({ error: 'Choose the country for your phone number.' })
  const phone = normalizePhone(input.phone, input.country)
  if (!phone) return response.status(400).json({ error: 'Enter a valid phone number for the selected country.' })
  if (!mailConfigured()) return response.status(503).json({ error: 'Email verification is not configured yet. Add BREVO_API_KEY and EMAIL_FROM to backend/.env.' })
  const email = input.email.toLowerCase()
  const { rowCount: phoneTaken } = await query('SELECT 1 FROM users WHERE phone = $1', [phone])
  if (phoneTaken) return response.status(409).json({ error: 'An account already uses this phone number. Try logging in instead.' })
  const { rowCount: emailTaken } = await query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [email])
  if (emailTaken) return response.status(409).json({ error: 'An account already uses this email address. Try logging in instead.' })

  const passwordHash = await bcrypt.hash(input.password, 12)
  await query('DELETE FROM pending_signups WHERE expires_at < NOW() - INTERVAL \'1 day\'')
  await query('DELETE FROM pending_signups WHERE phone = $1 OR LOWER(email) = LOWER($2)', [phone, email])
  const { rows } = await query(`INSERT INTO pending_signups (phone, country, display_name, email, password_hash, code_hash, expires_at)
    VALUES ($1, $2, $3, $4, $5, 'pending', NOW() + INTERVAL '10 minutes') RETURNING *`,
    [phone, input.country, input.displayName, email, passwordHash])
  const pending = rows[0]
  try {
    await issueSignupCode(pending)
  } catch (error) {
    await query('DELETE FROM pending_signups WHERE id = $1', [pending.id])
    throw error
  }
  response.status(201).json({ pendingId: pending.id, email, phone: formatPhone(phone), expiresInSeconds: 600 })
}))

app.post('/api/auth/register/verify', codeLimiter, asyncRoute(async (request, response) => {
  const { pendingId, code } = parse(signupVerifySchema, request.body)
  const { rows } = await query('SELECT * FROM pending_signups WHERE id = $1', [pendingId])
  const pending = rows[0]
  if (!pending) return response.status(400).json({ error: 'This sign-up has expired. Please start again.' })
  if (pending.attempts >= 5) return response.status(429).json({ error: 'Too many incorrect codes. Please start again.' })
  if (new Date(pending.expires_at) < new Date()) return response.status(410).json({ error: 'This code has expired. Request a new one.' })
  const expected = Buffer.from(hashSignupCode(pending.id, code), 'hex')
  const received = Buffer.from(pending.code_hash, 'hex')
  const matches = expected.length === received.length && crypto.timingSafeEqual(expected, received)
  if (!matches) {
    await query('UPDATE pending_signups SET attempts = attempts + 1 WHERE id = $1', [pending.id])
    return response.status(400).json({ error: 'That code is not correct.' })
  }

  let user
  try {
    const inserted = await query(`INSERT INTO users (email, password_hash, display_name, phone, phone_country, email_verified_at)
      VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`, [pending.email.toLowerCase(), pending.password_hash, pending.display_name, pending.phone, pending.country])
    user = inserted.rows[0]
  } catch (error) {
    if (error.code === '23505') {
      await query('DELETE FROM pending_signups WHERE id = $1', [pending.id])
      return response.status(409).json({ error: 'An account with this phone number or email already exists.' })
    }
    throw error
  }
  await query('DELETE FROM pending_signups WHERE id = $1', [pending.id])
  await deliverPendingInvites(user.id)
  await authResponse(response.status(201), user)
}))

app.post('/api/auth/register/resend', codeLimiter, asyncRoute(async (request, response) => {
  const { pendingId } = parse(z.object({ pendingId: z.string().uuid() }), request.body)
  const { rows } = await query('SELECT * FROM pending_signups WHERE id = $1', [pendingId])
  const pending = rows[0]
  if (!pending) return response.status(400).json({ error: 'This sign-up has expired. Please start again.' })
  if (Date.now() - new Date(pending.last_sent_at).getTime() < 60_000) return response.status(429).json({ error: 'Wait a minute before requesting another code.' })
  if (!mailConfigured()) return response.status(503).json({ error: 'Email verification is not configured yet.' })
  await issueSignupCode(pending)
  response.json({ message: 'A new code is on its way.' })
}))

app.post('/api/auth/login', loginLimiter, asyncRoute(async (request, response) => {
  const { identifier, email, country, password } = parse(loginSchema, request.body)
  const value = (identifier || email).trim()
  let user = null
  if (value.includes('@')) {
    const { rows } = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [value])
    user = rows[0]
  } else {
    const phone = normalizePhone(value, country)
    if (phone) user = await findUserByPhone(phone)
  }
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return response.status(401).json({ error: 'Invalid phone number, email, or password.' })
  await query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id])
  await deliverPendingInvites(user.id)
  await authResponse(response, user)
}))

app.post('/api/auth/logout', (_request, response) => {
  response.clearCookie('chat_access_token', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' })
  response.status(204).end()
})

// Permanently deletes the account, its chats, and every file it owns.
app.delete('/api/users/me', requireAuth, asyncRoute(async (request, response) => {
  const userId = request.auth.sub
  const [avatar, statusMedia, messageMedia] = await Promise.all([
    query('SELECT avatar_url FROM users WHERE id = $1', [userId]),
    query('SELECT media_url FROM statuses WHERE user_id = $1', [userId]),
    query(`SELECT media_url FROM messages WHERE media_url IS NOT NULL AND (sender_id = $1
      OR chat_id IN (SELECT id FROM chats WHERE (type = 'direct' AND (user_one_id = $1 OR user_two_id = $1))
        OR (type = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.chat_id = chats.id AND gm.user_id = $1))))`, [userId]),
  ])
  const files = [avatar.rows[0]?.avatar_url, ...statusMedia.rows.map((row) => row.media_url), ...messageMedia.rows.map((row) => row.media_url)]
  await query('DELETE FROM users WHERE id = $1', [userId])
  // Group rows have nullable owners, so remove any group left without members.
  await query(`DELETE FROM chats c WHERE c.type = 'group'
    AND NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.chat_id = c.id)`)
  response.clearCookie('chat_access_token', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' })
  response.status(204).end()
  for (const file of files) await deleteStoredFile(file)
}))

app.get('/api/auth/me', requireAuth, asyncRoute(async (request, response) => {
  const user = await getUser(request.auth.sub)
  if (!user) return response.status(401).json({ error: 'Account not found.' })
  response.json({ user: serializeUser(user, user.id) })
}))

app.post('/api/auth/forgot-password', resetLimiter, asyncRoute(async (request, response) => {
  const email = parse(z.object({ email: z.string().trim().email().max(254) }), request.body).email
  if (!mailConfigured()) return response.status(503).json({ error: 'Password recovery is unavailable because email delivery is not configured.' })
  const { rows } = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email])
  const user = rows[0]
  if (user) {
    const { token, hash } = createResetToken()
    await query('UPDATE users SET reset_token_hash = $1, reset_token_expires_at = NOW() + INTERVAL \'1 hour\' WHERE id = $2', [hash, user.id])
    const resetUrl = `${CLIENT_URL}/?reset=${token}`
    try {
      await sendMail({
        to: user.email,
        subject: 'Reset your Chat App password',
        text: `Reset your Chat App password within one hour: ${resetUrl}`,
        html: `<p>Reset your password by opening this link. It expires in one hour:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
      })
    } catch (error) {
      console.error('Password reset email could not be sent:', error.message)
    }
  }
  response.json({ message: 'If an account exists for that email, a reset link has been sent.' })
}))

app.post('/api/auth/reset-password', resetLimiter, asyncRoute(async (request, response) => {
  const { token, password } = parse(z.object({ token: z.string().min(32).max(128), password: z.string().min(8).max(128) }), request.body)
  const { rows } = await query(`SELECT * FROM users WHERE reset_token_hash = $1 AND reset_token_expires_at > NOW()`, [hashToken(token)])
  const user = rows[0]
  if (!user) return response.status(400).json({ error: 'This reset link is invalid or has expired.' })
  const passwordHash = await bcrypt.hash(password, 12)
  const { rows: updated } = await query(`UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL,
    token_version = token_version + 1 WHERE id = $2 RETURNING *`, [passwordHash, user.id])
  await authResponse(response, updated[0])
}))

app.patch('/api/users/me', requireAuth, asyncRoute(async (request, response) => {
  const changes = parse(profileSchema, request.body)
  const current = await getUser(request.auth.sub)
  let phone = null
  let phoneCountry = null
  if (changes.phone) {
    if (current.phone) return response.status(400).json({ error: 'Your phone number is already set.' })
    if (!changes.country || !isCountryCode(changes.country)) return response.status(400).json({ error: 'Choose the country for your phone number.' })
    phone = normalizePhone(changes.phone, changes.country)
    if (!phone) return response.status(400).json({ error: 'Enter a valid phone number.' })
    if (await findUserByPhone(phone)) return response.status(409).json({ error: 'That phone number is already registered.' })
    phoneCountry = changes.country
  }
  const { rows } = await query(`UPDATE users SET display_name = COALESCE($1, display_name), bio = COALESCE($2, bio),
      phone = COALESCE($3, phone), phone_country = COALESCE($4, phone_country), updated_at = NOW()
    WHERE id = $5 RETURNING *`, [changes.displayName ?? null, changes.bio ?? null, phone, phoneCountry, request.auth.sub])
  if (phone) await deliverPendingInvites(request.auth.sub)
  if (changes.displayName !== undefined) await broadcastUserUpdate(request.auth.sub)
  response.json({ user: serializeUser(rows[0], request.auth.sub) })
}))

app.post('/api/users/me/avatar', requireAuth, uploadLimiter, uploadIpLimiter, upload.single('avatar'), asyncRoute(async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Choose an image file up to 5 MB.' })
  const stored = await handleUpload(request, 'avatar')
  const { rows: current } = await query('SELECT avatar_url FROM users WHERE id = $1', [request.auth.sub])
  const { rows } = await query('UPDATE users SET avatar_url = $1, avatar_media_id = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
    [stored.storedUrl, stored.id, request.auth.sub])
  if (current[0]?.avatar_url && current[0].avatar_url !== stored.storedUrl) await deleteStoredFile(current[0].avatar_url)
  await broadcastUserUpdate(request.auth.sub)
  response.json({ user: serializeUser(rows[0], request.auth.sub) })
}))

app.get('/api/users/me/storage', requireAuth, asyncRoute(async (request, response) => {
  const { rows } = await query(`SELECT COALESCE(SUM(byte_size), 0)::bigint AS used, COUNT(*)::int AS objects
    FROM media_objects WHERE owner_id = $1 AND deleted_at IS NULL`, [request.auth.sub])
  response.json({
    usedBytes: Number(rows[0].used),
    objects: rows[0].objects,
    quotaBytes: media.limits.ACCOUNT_QUOTA_BYTES,
    dailyQuotaBytes: media.limits.DAILY_QUOTA_BYTES,
    maxObjects: media.limits.MAX_OBJECTS,
  })
}))

app.get('/api/users/me/privacy', requireAuth, asyncRoute(async (request, response) => {
  const user = await getUser(request.auth.sub)
  response.json(serializeUser(user, user.id).privacy)
}))

app.patch('/api/users/me/privacy', requireAuth, asyncRoute(async (request, response) => {
  const changes = parse(privacySchema, request.body)
  const { rows } = await query(`UPDATE users SET presence_visible = COALESCE($1, presence_visible), last_seen_visible = COALESCE($2, last_seen_visible),
      contact_permission = COALESCE($3, contact_permission), findable_by_phone = COALESCE($4, findable_by_phone), updated_at = NOW()
    WHERE id = $5 RETURNING *`, [changes.presenceVisible ?? null, changes.lastSeenVisible ?? null, changes.contactPermission ?? null, changes.findableByPhone ?? null, request.auth.sub])
  if (changes.presenceVisible === false) broadcastPresence(request.auth.sub, { online: false, notify: true })
  response.json(serializeUser(rows[0], request.auth.sub).privacy)
}))

app.post('/api/users/:userId/block', requireAuth, asyncRoute(async (request, response) => {
  if (request.params.userId === request.auth.sub) return response.status(400).json({ error: 'You cannot block yourself.' })
  if (!(await getUser(request.params.userId))) return response.status(404).json({ error: 'User not found.' })
  await query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [request.auth.sub, request.params.userId])
  response.status(204).end()
}))

app.delete('/api/users/:userId/block', requireAuth, asyncRoute(async (request, response) => {
  await query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [request.auth.sub, request.params.userId])
  response.status(204).end()
}))

app.post('/api/users/:userId/report', requireAuth, asyncRoute(async (request, response) => {
  const { reason, details = '' } = parse(z.object({ reason: z.string().trim().min(2).max(80), details: z.string().trim().max(1000).optional() }), request.body)
  if (request.params.userId === request.auth.sub) return response.status(400).json({ error: 'You cannot report yourself.' })
  if (!(await getUser(request.params.userId))) return response.status(404).json({ error: 'User not found.' })
  await query('INSERT INTO reports (reporter_id, reported_id, reason, details) VALUES ($1, $2, $3, $4)', [request.auth.sub, request.params.userId, reason, details])
  response.status(201).json({ message: 'Report submitted.' })
}))

function inviteUrlFor(phone) {
  return `${CLIENT_URL}/?phone=${encodeURIComponent(phone)}`
}

function whatsappInviteUrl(phone, name) {
  const message = `Hi! ${name} invited you to chat on Chat App. Open ${inviteUrlFor(phone)} to create your account.`
  return `https://wa.me/${phone.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`
}

app.get('/api/contacts', requireAuth, asyncRoute(async (request, response) => {
  await query('UPDATE contacts c SET contact_id = u.id FROM users u WHERE c.owner_id = $1 AND c.contact_id IS NULL AND u.phone = c.phone', [request.auth.sub])
  const { rows } = await query(`SELECT c.phone, c.display_name AS saved_name, c.contact_id,
      u.display_name, u.avatar_url, u.presence_visible, u.last_seen_visible, u.last_seen_at, dc.id AS chat_id
    FROM contacts c
    LEFT JOIN users u ON u.id = c.contact_id
    LEFT JOIN chats dc ON dc.type = 'direct' AND c.contact_id IS NOT NULL
      AND dc.user_one_id = LEAST($1::uuid, c.contact_id) AND dc.user_two_id = GREATEST($1::uuid, c.contact_id)
    WHERE c.owner_id = $1
    ORDER BY LOWER(COALESCE(u.display_name, c.display_name, c.phone))`, [request.auth.sub])
  const contacts = rows.map((row) => ({
    id: row.contact_id,
    phone: row.phone,
    formattedPhone: formatPhone(row.phone),
    displayName: row.display_name || row.saved_name || formatPhone(row.phone),
    avatar: initials(row.display_name || row.saved_name),
    color: colorFor(row.contact_id || row.phone),
    avatarUrl: publicMediaUrl(row.avatar_url),
    online: Boolean(row.contact_id && row.presence_visible && onlineUsers.has(row.contact_id)),
    lastSeenAt: row.last_seen_visible ? row.last_seen_at : null,
    chatId: row.chat_id,
    registered: Boolean(row.contact_id),
  }))
  const { rows: invites } = await query(`SELECT i.phone, i.created_at FROM phone_invites i
    WHERE i.inviter_id = $1 AND i.consumed_at IS NULL ORDER BY i.created_at DESC`, [request.auth.sub])
  response.json({
    contacts,
    invites: invites.map((invite) => ({ phone: invite.phone, formattedPhone: formatPhone(invite.phone), createdAt: invite.created_at, inviteUrl: inviteUrlFor(invite.phone) })),
  })
}))

app.post('/api/contacts', requireAuth, inviteLimiter, asyncRoute(async (request, response) => {
  const input = parse(z.object({
    country: z.string().trim().length(2),
    phone: z.string().trim().min(4).max(24),
    displayName: z.string().trim().max(80).optional(),
  }), request.body)
  const country = input.country.toUpperCase()
  if (!isCountryCode(country)) return response.status(400).json({ error: 'Choose a valid country.' })
  const phone = normalizePhone(input.phone, country)
  if (!phone) return response.status(400).json({ error: 'Enter a valid phone number for the selected country.' })
  const me = await getUser(request.auth.sub)
  if (me.phone === phone) return response.status(400).json({ error: 'That is your own phone number.' })

  const target = await findUserByPhone(phone)
  if (target && target.findable_by_phone === false) return response.status(404).json({ error: 'This number cannot be found on Chat App.' })

  if (target) {
    const permission = await canContact(request.auth.sub, target.id)
    if (!permission.allowed) return response.status(403).json({ error: permission.reason })
    await query(`INSERT INTO contacts (owner_id, phone, contact_id, display_name) VALUES ($1, $2, $3, $4)
      ON CONFLICT (owner_id, phone) DO UPDATE SET contact_id = EXCLUDED.contact_id,
        display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), contacts.display_name)`,
      [request.auth.sub, phone, target.id, input.displayName || target.display_name])
    const [one, two] = [request.auth.sub, target.id].sort()
    const chat = await getOrCreateDirectChat(one, two)
    io.to(`user:${target.id}`).emit('chat:new', await serializeChat(chat, target.id))
    return response.status(201).json({
      contact: {
        id: target.id, phone, formattedPhone: formatPhone(phone), displayName: input.displayName || target.display_name,
        avatar: initials(target.display_name), color: colorFor(target.id), avatarUrl: publicMediaUrl(target.avatar_url),
        online: Boolean(target.presence_visible && onlineUsers.has(target.id)), chatId: chat.id, registered: true,
      },
      chat: await serializeChat(chat, request.auth.sub),
    })
  }

  await query('INSERT INTO phone_invites (inviter_id, phone) VALUES ($1, $2) ON CONFLICT (inviter_id, phone) DO NOTHING', [request.auth.sub, phone])
  await query(`INSERT INTO contacts (owner_id, phone, display_name) VALUES ($1, $2, $3)
    ON CONFLICT (owner_id, phone) DO UPDATE SET display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), contacts.display_name)`,
    [request.auth.sub, phone, input.displayName || ''])
  response.status(201).json({
    pending: true, phone, formattedPhone: formatPhone(phone),
    inviteUrl: inviteUrlFor(phone), whatsappUrl: whatsappInviteUrl(phone, me.display_name),
  })
}))

app.delete('/api/contacts/:phone', requireAuth, asyncRoute(async (request, response) => {
  const phone = normalizePhone(decodeURIComponent(request.params.phone))
  if (!phone) return response.status(400).json({ error: 'Enter a valid phone number.' })
  await query('DELETE FROM contacts WHERE owner_id = $1 AND phone = $2', [request.auth.sub, phone])
  await query('DELETE FROM phone_invites WHERE inviter_id = $1 AND phone = $2 AND consumed_at IS NULL', [request.auth.sub, phone])
  response.status(204).end()
}))

app.get('/api/statuses', requireAuth, asyncRoute(async (request, response) => {
  const { rows } = await query(`SELECT s.*, u.display_name, u.avatar_url FROM statuses s JOIN users u ON u.id = s.user_id
    WHERE s.created_at > NOW() - INTERVAL '24 hours'
      AND (s.user_id = $1
        OR s.user_id IN (SELECT contact_id FROM contacts WHERE owner_id = $1 AND contact_id IS NOT NULL)
        OR s.user_id IN (SELECT CASE WHEN user_one_id = $1 THEN user_two_id ELSE user_one_id END
          FROM chats WHERE type = 'direct' AND (user_one_id = $1 OR user_two_id = $1))
        OR s.user_id IN (SELECT gm2.user_id FROM group_members gm1
          JOIN group_members gm2 ON gm2.chat_id = gm1.chat_id WHERE gm1.user_id = $1))
      AND NOT EXISTS (SELECT 1 FROM blocks b
        WHERE (b.blocker_id = $1 AND b.blocked_id = s.user_id) OR (b.blocker_id = s.user_id AND b.blocked_id = $1))
    ORDER BY s.created_at DESC`, [request.auth.sub])
  response.json(rows.map((status) => ({
    id: status.id, author: status.user_id === request.auth.sub ? 'You' : status.display_name,
    avatar: initials(status.display_name), color: colorFor(status.user_id), text: status.text,
    mediaUrl: publicMediaUrl(status.media_url), mediaType: status.media_type, createdAt: status.created_at,
  })))
}))

app.post('/api/statuses', requireAuth, uploadLimiter, uploadIpLimiter, statusLimiter, mediaUpload.single('media'), asyncRoute(async (request, response) => {
  const text = String(request.body.text || '').trim().slice(0, 500)
  if (!text && !request.file) return response.status(400).json({ error: 'Add text or a photo/video to your status.' })
  const stored = request.file ? await handleUpload(request, 'status') : null
  const mediaUrl = stored?.storedUrl || null
  const { rows } = await query(`INSERT INTO statuses (user_id, text, media_url, media_type, media_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [request.auth.sub, text, mediaUrl, stored?.mime || null, stored?.id || null])
  const status = rows[0]
  const user = await getUser(request.auth.sub)
  const payload = { id: status.id, avatar: initials(user.display_name), color: colorFor(user.id), text: status.text, mediaUrl: publicMediaUrl(status.media_url), mediaType: status.media_type, createdAt: status.created_at }
  const audience = await statusAudience(request.auth.sub)
  for (const id of audience) {
    io.to(`user:${id}`).emit('status:new', { ...payload, author: id === request.auth.sub ? 'You' : user.display_name })
  }
  response.status(201).json({ ...payload, author: 'You' })
}))

app.get('/api/chats', requireAuth, asyncRoute(async (request, response) => response.json(await getChatsForUser(request.auth.sub))))

app.post('/api/chats/direct', requireAuth, asyncRoute(async (request, response) => {
  const { userId } = parse(z.object({ userId: z.string().uuid() }), request.body)
  if (userId === request.auth.sub) return response.status(400).json({ error: 'You cannot start a chat with yourself.' })
  const permission = await canContact(request.auth.sub, userId)
  if (!permission.allowed) return response.status(403).json({ error: permission.reason })
  const [one, two] = [request.auth.sub, userId].sort()
  const chat = await getOrCreateDirectChat(one, two)
  const chatForViewer = await serializeChat(chat, request.auth.sub)
  const chatForRecipient = await serializeChat(chat, userId)
  io.to(`user:${userId}`).emit('chat:new', chatForRecipient)
  response.status(201).json(chatForViewer)
}))

// Groups are chats with a name and an explicit member list. Everyone gets the
// same message thread, and each member is notified with their own chat payload.
app.post('/api/groups', requireAuth, asyncRoute(async (request, response) => {
  const { name, memberIds } = parse(z.object({
    name: z.string().trim().min(1, 'Give the group a name.').max(80),
    memberIds: z.array(z.string().uuid()).min(1, 'Choose at least one person.').max(50),
  }), request.body)
  const members = [...new Set(memberIds.filter((id) => id !== request.auth.sub))]
  if (!members.length) return response.status(400).json({ error: 'Choose at least one person for the group.' })
  const { rows: known } = await query(`SELECT u.id FROM users u WHERE u.id = ANY($1::uuid[]) AND (
      EXISTS (SELECT 1 FROM contacts c WHERE (c.owner_id = $2 AND c.contact_id = u.id) OR (c.owner_id = u.id AND c.contact_id = $2))
      OR EXISTS (SELECT 1 FROM chats x WHERE x.type = 'direct'
        AND ((x.user_one_id = $2 AND x.user_two_id = u.id) OR (x.user_two_id = $2 AND x.user_one_id = u.id)))
    ) AND NOT EXISTS (SELECT 1 FROM blocks b
      WHERE (b.blocker_id = $2 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $2))`,
  [members, request.auth.sub])
  if (known.length !== members.length) return response.status(400).json({ error: 'You can only add people you chat with or have saved.' })
  const chat = await transaction(async (client) => {
    const { rows } = await client.query(`INSERT INTO chats (type, name, created_by) VALUES ('group', $1, $2) RETURNING *`, [name, request.auth.sub])
    const group = rows[0]
    await client.query('INSERT INTO group_members (chat_id, user_id) SELECT $1, unnest($2::uuid[])', [group.id, [request.auth.sub, ...members]])
    return group
  })
  for (const memberId of [request.auth.sub, ...members]) {
    try { io.to(`user:${memberId}`).emit('chat:new', await serializeChat(chat, memberId)) } catch { /* Their next refresh picks it up. */ }
  }
  response.status(201).json(await serializeChat(chat, request.auth.sub))
}))

app.get('/api/chats/:chatId/messages', requireAuth, asyncRoute(async (request, response) => {
  await ensureChatMember(request.params.chatId, request.auth.sub)
  await requireChatAccess(request.params.chatId, request.auth.sub, request.get('x-chat-unlock'))
  const before = request.query.before ? new Date(String(request.query.before)) : null
  if (before && Number.isNaN(before.getTime())) return response.status(400).json({ error: 'Invalid message cursor.' })
  response.json(await getChatMessages(request.params.chatId, request.auth.sub, 100, before))
}))

const requireChatMembership = asyncRoute(async (request, _response, next) => {
  await ensureChatMember(request.params.chatId, request.auth.sub)
  await requireChatAccess(request.params.chatId, request.auth.sub, request.get('x-chat-unlock'))
  next()
})

// Photos are uploaded first and referenced by path, never embedded in messages.
app.post('/api/chats/:chatId/attachments', requireAuth, uploadLimiter, uploadIpLimiter, requireChatMembership, upload.single('file'), asyncRoute(async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Choose an image up to 5 MB.' })
  const stored = await handleUpload(request, 'chat')
  response.status(201).json({ path: stored.storedUrl, url: publicMediaUrl(stored.storedUrl), mediaId: stored.id })
}))

app.post('/api/chats/:chatId/messages', requireAuth, messageLimiter, asyncRoute(async (request, response) => {
  const payload = parse(z.object({ text: z.string().max(4000).optional(), image: z.string().max(9_000_000).optional(), sticker: z.string().max(32).optional(), replyToId: z.string().uuid().optional(), unlockToken: z.string().max(200).optional() }), request.body)
  await ensureChatMember(request.params.chatId, request.auth.sub)
  await requireChatAccess(request.params.chatId, request.auth.sub, payload.unlockToken || request.get('x-chat-unlock'))
  const message = await createMessage({ chatId: request.params.chatId, senderId: request.auth.sub, text: payload.text, image: payload.image, sticker: payload.sticker, replyToId: payload.replyToId })
  io.to(roomFor(request.params.chatId)).emit('message:new', { chatId: request.params.chatId, message })
  response.status(201).json({ chatId: request.params.chatId, message })
}))

app.patch('/api/messages/:messageId', requireAuth, asyncRoute(async (request, response) => {
  const { text } = parse(z.object({ text: z.string().trim().min(1).max(4000) }), request.body)
  const { rows: found } = await query('SELECT chat_id FROM messages WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL', [request.params.messageId, request.auth.sub])
  if (!found[0]) return response.status(404).json({ error: 'Message not found or not editable.' })
  await requireChatAccess(found[0].chat_id, request.auth.sub, request.get('x-chat-unlock'))
  const { rows } = await query(`UPDATE messages SET body = $1, edited_at = NOW() WHERE id = $2 RETURNING id, chat_id`, [text, request.params.messageId])
  const message = await loadMessage(rows[0].id, request.auth.sub)
  io.to(roomFor(rows[0].chat_id)).emit('message:updated', { chatId: rows[0].chat_id, message })
  response.json(message)
}))

app.delete('/api/messages/:messageId', requireAuth, asyncRoute(async (request, response) => {
  const { rows: existing } = await query('SELECT chat_id, media_url FROM messages WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL', [request.params.messageId, request.auth.sub])
  if (!existing[0]) return response.status(404).json({ error: 'Message not found or not deletable.' })
  await requireChatAccess(existing[0].chat_id, request.auth.sub, request.get('x-chat-unlock'))
  await query(`UPDATE messages SET body = 'This message was deleted.', media_url = NULL, sticker = NULL, deleted_at = NOW() WHERE id = $1`, [request.params.messageId])
  io.to(roomFor(existing[0].chat_id)).emit('message:deleted', { chatId: existing[0].chat_id, messageId: request.params.messageId })
  if (existing[0].media_url) await deleteStoredFile(existing[0].media_url)
  response.status(204).end()
}))

app.post('/api/messages/:messageId/forward', requireAuth, asyncRoute(async (request, response) => {
  const { targetChatId, unlockToken: targetToken } = parse(z.object({ targetChatId: z.string().uuid(), unlockToken: z.string().max(200).optional() }), request.body)
  await ensureChatMember(targetChatId, request.auth.sub)
  await requireChatAccess(targetChatId, request.auth.sub, targetToken)
  const { rows } = await query('SELECT * FROM messages WHERE id = $1', [request.params.messageId])
  if (!rows[0]) return response.status(404).json({ error: 'Message not found.' })
  const source = rows[0]
  await ensureChatMember(source.chat_id, request.auth.sub)
  await requireChatAccess(source.chat_id, request.auth.sub, request.get('x-chat-unlock'))
  const message = await createMessage({ chatId: targetChatId, senderId: request.auth.sub, text: source.body, image: MEDIA_FILE_PATTERN.test(String(source.media_url || '').replace('/uploads/', '')) ? source.media_url : null, sticker: source.sticker, forwardedFromId: source.id })
  io.to(roomFor(targetChatId)).emit('message:new', { chatId: targetChatId, message })
  response.status(201).json(message)
}))

app.post('/api/messages/:messageId/reactions', requireAuth, asyncRoute(async (request, response) => {
  const { emoji } = parse(z.object({ emoji: z.string().trim().min(1).max(16) }), request.body)
  const { rows } = await query('SELECT chat_id FROM messages WHERE id = $1', [request.params.messageId])
  if (!rows[0]) return response.status(404).json({ error: 'Message not found.' })
  await ensureChatMember(rows[0].chat_id, request.auth.sub)
  await requireChatAccess(rows[0].chat_id, request.auth.sub, request.get('x-chat-unlock'))
  await query('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [request.params.messageId, request.auth.sub, emoji])
  const message = await loadMessage(request.params.messageId, request.auth.sub)
  io.to(roomFor(rows[0].chat_id)).emit('message:updated', { chatId: rows[0].chat_id, message })
  response.status(201).json(message)
}))

app.delete('/api/messages/:messageId/reactions/:emoji', requireAuth, asyncRoute(async (request, response) => {
  const { rows } = await query('SELECT chat_id FROM messages WHERE id = $1', [request.params.messageId])
  if (!rows[0]) return response.status(404).json({ error: 'Message not found.' })
  await ensureChatMember(rows[0].chat_id, request.auth.sub)
  await requireChatAccess(rows[0].chat_id, request.auth.sub, request.get('x-chat-unlock'))
  await query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [request.params.messageId, request.auth.sub, request.params.emoji])
  const message = await loadMessage(request.params.messageId, request.auth.sub)
  io.to(roomFor(rows[0].chat_id)).emit('message:updated', { chatId: rows[0].chat_id, message })
  response.json(message)
}))

async function starMessage({ messageId, userId, starred }) {
  const { rows } = await query('SELECT chat_id FROM messages WHERE id = $1', [messageId])
  if (!rows[0]) { const error = new Error('Message not found.'); error.status = 404; throw error }
  await ensureChatMember(rows[0].chat_id, userId)
  if (starred) await query('INSERT INTO message_stars (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [messageId, userId])
  else await query('DELETE FROM message_stars WHERE message_id = $1 AND user_id = $2', [messageId, userId])
  // Stars are private to each account, so only the acting user's other tabs are notified.
  io.to(`user:${userId}`).emit('message:starred', { chatId: rows[0].chat_id, messageId, userId, starred })
  return loadMessage(messageId, userId)
}

app.post('/api/messages/:messageId/star', requireAuth, asyncRoute(async (request, response) => {
  response.status(201).json(await starMessage({ messageId: request.params.messageId, userId: request.auth.sub, starred: true }))
}))

app.delete('/api/messages/:messageId/star', requireAuth, asyncRoute(async (request, response) => {
  response.json(await starMessage({ messageId: request.params.messageId, userId: request.auth.sub, starred: false }))
}))

app.post('/api/chats/:chatId/read', requireAuth, asyncRoute(async (request, response) => {
  await ensureChatMember(request.params.chatId, request.auth.sub)
  // Read receipts are chat content too: a locked chat must not have its
  // receipts moved without the same unlock token the message routes require.
  await requireChatAccess(request.params.chatId, request.auth.sub, request.get('x-chat-unlock'))
  await query(`INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at)
    SELECT id, $2, NOW(), NOW() FROM messages WHERE chat_id = $1 AND sender_id <> $2
    ON CONFLICT (message_id, user_id) DO UPDATE SET delivered_at = COALESCE(message_receipts.delivered_at, NOW()), read_at = NOW()`, [request.params.chatId, request.auth.sub])
  io.to(roomFor(request.params.chatId)).emit('chat:read', { chatId: request.params.chatId, userId: request.auth.sub })
  response.status(204).end()
}))

// Failed PIN attempts are throttled per account and chat, not per IP. The
// counter lives in PostgreSQL so a restart or a second instance cannot reset it.
const UNLOCK_ATTEMPT_LIMIT = 10
const UNLOCK_ATTEMPT_WINDOW_SECONDS = 15 * 60

// One atomic upsert: the first attempt in a window starts it, later attempts
// increment it, and an expired window starts over. Returned count includes the
// attempt being made now, so the limit allows exactly UNLOCK_ATTEMPT_LIMIT tries.
async function recordUnlockAttempt(userId, chatId) {
  const { rows } = await query(`INSERT INTO chat_unlock_attempts (user_id, chat_id, window_start, attempts)
    VALUES ($1, $2, NOW(), 1)
    ON CONFLICT (user_id, chat_id) DO UPDATE SET
      attempts = CASE WHEN chat_unlock_attempts.window_start < NOW() - make_interval(secs => $3)
        THEN 1 ELSE chat_unlock_attempts.attempts + 1 END,
      window_start = CASE WHEN chat_unlock_attempts.window_start < NOW() - make_interval(secs => $3)
        THEN NOW() ELSE chat_unlock_attempts.window_start END
    RETURNING attempts`, [userId, chatId, UNLOCK_ATTEMPT_WINDOW_SECONDS])
  return Number(rows[0]?.attempts) || 1
}

async function clearUnlockAttempts(userId, chatId) {
  await query('DELETE FROM chat_unlock_attempts WHERE user_id = $1 AND chat_id = $2', [userId, chatId])
}

app.patch('/api/chats/:chatId/preferences', requireAuth, asyncRoute(async (request, response) => {
  const changes = parse(z.object({
    archived: z.boolean().optional(),
    locked: z.boolean().optional(),
    pin: z.string().trim().regex(/^\d{4,6}$/, 'Choose a 4–6 digit PIN.').optional(),
  }), request.body)
  await ensureChatMember(request.params.chatId, request.auth.sub)
  const existing = await chatLockState(request.params.chatId, request.auth.sub)
  if (changes.locked === true && !changes.pin && !existing.lock_pin_hash) {
    return response.status(400).json({ error: 'Choose a 4–6 digit PIN to lock this chat.' })
  }
  // A locked chat's PIN cannot be replaced while it is locked; unlock it first.
  if (existing.locked && changes.pin && changes.locked !== false) {
    return response.status(400).json({ error: 'Unlock this chat before changing its PIN.' })
  }
  if (changes.locked === false && existing.locked && existing.lock_pin_hash) {
    if (!changes.pin || !(await bcrypt.compare(changes.pin, existing.lock_pin_hash))) {
      return response.status(403).json({ error: 'Incorrect PIN.' })
    }
  }
  const pinHash = changes.pin ? await bcrypt.hash(changes.pin, 12) : null
  const { rows } = await query(`INSERT INTO chat_preferences (chat_id, user_id, archived, locked, lock_pin_hash)
    VALUES ($1, $2, COALESCE($3, FALSE), COALESCE($4, FALSE), $5)
    ON CONFLICT (chat_id, user_id) DO UPDATE SET archived = COALESCE($3, chat_preferences.archived),
      locked = COALESCE($4, chat_preferences.locked), lock_pin_hash = COALESCE($5, chat_preferences.lock_pin_hash)
    RETURNING archived, locked, (lock_pin_hash IS NOT NULL) AS has_pin`,
  [request.params.chatId, request.auth.sub, changes.archived ?? null, changes.locked ?? null, pinHash])
  // Locking takes effect immediately: the owner's open tabs leave the room.
  if (changes.locked === true) {
    for (const socket of io.of('/').sockets.values()) {
      if (socket.user?.sub === request.auth.sub) socket.leave(roomFor(request.params.chatId))
    }
  }
  response.json(rows[0])
}))

app.post('/api/chats/:chatId/unlock', requireAuth, asyncRoute(async (request, response) => {
  const { pin } = parse(z.object({ pin: z.string().trim().regex(/^\d{4,6}$/, 'Enter your 4–6 digit PIN.') }), request.body)
  await ensureChatMember(request.params.chatId, request.auth.sub)
  const state = await chatLockState(request.params.chatId, request.auth.sub)
  if (!state.locked) return response.json({ token: unlockToken(request.params.chatId, request.auth.sub), expiresIn: UNLOCK_TTL_SECONDS })
  const attempts = await recordUnlockAttempt(request.auth.sub, request.params.chatId)
  if (attempts > UNLOCK_ATTEMPT_LIMIT) return response.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' })
  if (!state.lock_pin_hash || !(await bcrypt.compare(pin, state.lock_pin_hash))) {
    return response.status(403).json({ error: 'Incorrect PIN.' })
  }
  // A correct PIN clears the window, so a legitimate unlock does not leave the
  // account one mistake away from a lockout.
  await clearUnlockAttempts(request.auth.sub, request.params.chatId)
  response.json({ token: unlockToken(request.params.chatId, request.auth.sub), expiresIn: UNLOCK_TTL_SECONDS })
}))

app.get('/api/search', requireAuth, asyncRoute(async (request, response) => {
  const term = String(request.query.query || '').trim()
  if (term.length < 2) return response.json({ chats: [], messages: [] })
  const chats = (await getChatsForUser(request.auth.sub)).filter((chat) => chat.name.toLowerCase().includes(term.toLowerCase()))
  const { rows } = await query(`SELECT m.id, m.chat_id, m.body, m.created_at, u.display_name AS sender_name FROM messages m
    JOIN chats c ON c.id = m.chat_id JOIN users u ON u.id = m.sender_id
    LEFT JOIN chat_preferences p ON p.chat_id = c.id AND p.user_id = $1
    WHERE ((c.type = 'direct' AND (c.user_one_id = $1 OR c.user_two_id = $1))
      OR (c.type = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.chat_id = c.id AND gm.user_id = $1)))
      AND m.deleted_at IS NULL AND m.body ILIKE $2
      AND COALESCE(p.locked, FALSE) = FALSE ORDER BY m.created_at DESC LIMIT 50`, [request.auth.sub, `%${term}%`])
  response.json({ chats, messages: rows.map((message) => ({ id: message.id, chatId: message.chat_id, text: message.body, senderName: message.sender_name, createdAt: message.created_at })) })
}))

app.get('/api/calls', requireAuth, asyncRoute(async (request, response) => {
  const { rows } = await query(`SELECT cl.*, caller.display_name AS caller_name, callee.display_name AS callee_name
    FROM call_logs cl JOIN users caller ON caller.id = cl.caller_id JOIN users callee ON callee.id = cl.callee_id
    WHERE cl.caller_id = $1 OR cl.callee_id = $1 ORDER BY cl.started_at DESC LIMIT 50`, [request.auth.sub])
  response.json(rows.map((row) => ({
    id: row.id,
    direction: row.caller_id === request.auth.sub ? 'Outgoing' : 'Incoming',
    contact: row.caller_id === request.auth.sub ? row.callee_name : row.caller_name,
    type: row.type, outcome: row.outcome, time: row.started_at,
    duration: row.ended_at ? Math.max(0, Math.round((new Date(row.ended_at) - new Date(row.started_at)) / 1000)) : null,
  })))
}))

// Live call sessions. Kept in memory on purpose: a call cannot outlive the server process.
const callSessions = new Map()
const CALL_RING_TIMEOUT_MS = Number(process.env.CALL_RING_TIMEOUT_MS) || 45_000

function sessionForSocket(socketId) {
  for (const session of callSessions.values()) {
    if (session.callerSocketId === socketId || session.calleeSocketId === socketId) return session
  }
  return null
}

function sessionForUser(userId) {
  for (const session of callSessions.values()) {
    if (session.callerId === userId || session.calleeId === userId) return session
  }
  return null
}

// Always notify by user room: while ringing the callee socket id is still unknown,
// and the other side may be connected from more than one tab.
function finishCall(callId, reason) {
  const session = callSessions.get(callId)
  if (!session) return null
  callSessions.delete(callId)
  clearTimeout(session.timer)
  const payload = { callId, reason }
  io.to(`user:${session.callerId}`).emit('call:ended', payload)
  io.to(`user:${session.calleeId}`).emit('call:ended', payload)
  recordCall(session, reason)
  return session
}

function recordCall(session, outcome) {
  query(`INSERT INTO call_logs (caller_id, callee_id, chat_id, type, outcome, started_at, ended_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
  [session.callerId, session.calleeId, session.chatId, session.type, outcome, new Date(session.startedAt)])
    .catch((error) => console.error('Unable to record the call:', error.message))
}

function recordUnavailableCall({ callerId, calleeId, chatId, type, outcome }) {
  query(`INSERT INTO call_logs (caller_id, callee_id, chat_id, type, outcome, started_at, ended_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`, [callerId, calleeId, chatId, type, outcome])
    .catch((error) => console.error('Unable to record the call:', error.message))
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('chat_access_token='))?.split('=')[1]
    if (!token) return next(new Error('Authentication required'))
    socket.user = verifyAccessToken(decodeURIComponent(token))
    const { rows } = await query('SELECT token_version FROM users WHERE id = $1', [socket.user.sub])
    if (!rows[0] || (Number(socket.user.ver) || 0) !== rows[0].token_version) return next(new Error('Invalid session'))
    next()
  } catch { next(new Error('Invalid session')) }
})

io.on('connection', (socket) => {
  const userId = socket.user.sub
  const socketCount = (onlineUsers.get(userId) || 0) + 1
  onlineUsers.set(userId, socketCount)
  socket.join(`user:${userId}`)
  if (socketCount === 1) broadcastPresence(userId, { online: true })
  // Join room subscriptions in the background so event handlers below are
  // registered immediately; otherwise an event sent right after connect can
  // be missed while the first database query is still running.
  ;(async () => {
    try {
      const { rows } = await query(`SELECT c.id FROM chats c
        LEFT JOIN chat_preferences p ON p.chat_id = c.id AND p.user_id = $1
        WHERE ((c.type = 'direct' AND (c.user_one_id = $1 OR c.user_two_id = $1))
          OR (c.type = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.chat_id = c.id AND gm.user_id = $1)))
          AND COALESCE(p.locked, FALSE) = FALSE`, [userId])
      rows.forEach((chat) => socket.join(roomFor(chat.id)))
      markAllDelivered(userId).catch((error) => console.error('Unable to record deliveries:', error.message))
    } catch (error) { console.error('Unable to join chat rooms:', error.message) }
  })()

  socket.on('chat:join', async ({ chatId, unlockToken: token }, acknowledge) => {
    try {
      await ensureChatMember(chatId, userId)
      await requireChatAccess(chatId, userId, token)
      socket.join(roomFor(chatId))
      acknowledge?.({ ok: true })
    } catch (error) { acknowledge?.({ ok: false, error: error.message }) }
  })
  socket.on('chat:typing', async ({ chatId, isTyping, unlockToken: token }) => {
    try {
      await ensureChatMember(chatId, userId)
      await requireChatAccess(chatId, userId, token)
      socket.to(roomFor(chatId)).emit('chat:typing', { chatId, userId, isTyping })
    } catch { /* Ignore unauthorized events. */ }
  })
  socket.on('message:send', async (payload, acknowledge) => {
    if (!allowSocketMessage(userId)) return acknowledge?.({ ok: false, error: 'You are sending messages too quickly. Slow down for a moment.' })
    try {
      await ensureChatMember(payload.chatId, userId)
      await requireChatAccess(payload.chatId, userId, payload.unlockToken)
      const message = await createMessage({ chatId: payload.chatId, senderId: userId, text: payload.text, image: payload.image, sticker: payload.sticker, replyToId: payload.replyToId })
      io.to(roomFor(payload.chatId)).emit('message:new', { chatId: payload.chatId, message })
      acknowledge?.({ ok: true, message })
    } catch (error) { acknowledge?.({ ok: false, error: error.message }) }
  })
  socket.on('chat:read', async ({ chatId, unlockToken: token }) => {
    try {
      await ensureChatMember(chatId, userId)
      await requireChatAccess(chatId, userId, token)
      await query(`INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at) SELECT id, $2, NOW(), NOW() FROM messages WHERE chat_id = $1 AND sender_id <> $2 ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = NOW()`, [chatId, userId])
      io.to(roomFor(chatId)).emit('chat:read', { chatId, userId })
    } catch { /* Ignore unauthorized events. */ }
  })
  socket.on('call:request', async ({ chatId, callId, type, unlockToken: token }, acknowledge) => {
    try {
      const chat = await ensureChatMember(chatId, userId)
      await requireChatAccess(chatId, userId, token)
      if (chat.type === 'group') throw new Error('Calls are only available in one-to-one chats.')
      if (!callId || !['audio', 'video'].includes(type)) throw new Error('Unable to start this call.')
      const recipientId = chat.user_one_id === userId ? chat.user_two_id : chat.user_one_id
      if (await isBlocked(userId, recipientId)) throw new Error('Calling is unavailable for this user.')
      if (callSessions.has(callId)) throw new Error('This call is already active.')
      if (sessionForUser(userId)) throw new Error('You are already in a call.')
      if (sessionForUser(recipientId)) {
        recordUnavailableCall({ callerId: userId, calleeId: recipientId, chatId, type, outcome: 'busy' })
        return acknowledge?.({ ok: false, error: 'They are on another call right now.' })
      }
      if (!onlineUsers.has(recipientId)) {
        recordUnavailableCall({ callerId: userId, calleeId: recipientId, chatId, type, outcome: 'offline' })
        return acknowledge?.({ ok: false, error: 'They are offline right now.' })
      }
      const caller = await getUser(userId)
      const session = {
        callId, chatId, type, state: 'ringing', startedAt: Date.now(),
        callerId: userId, callerSocketId: socket.id, calleeId: recipientId, calleeSocketId: null,
      }
      session.timer = setTimeout(() => {
        const current = callSessions.get(callId)
        if (current?.state === 'ringing') finishCall(callId, 'no-answer')
      }, CALL_RING_TIMEOUT_MS)
      callSessions.set(callId, session)
      io.to(`user:${recipientId}`).emit('call:incoming', { chatId, callId, type, callerSocketId: socket.id, callerName: caller.display_name })
      acknowledge?.({ ok: true })
    } catch (error) { acknowledge?.({ ok: false, error: error.message }) }
  })
  socket.on('call:accept', ({ callId }, acknowledge) => {
    const session = callSessions.get(callId)
    if (!session || session.calleeId !== userId) return acknowledge?.({ ok: false, error: 'This call is no longer available.' })
    session.calleeSocketId = socket.id
    session.state = 'accepted'
    clearTimeout(session.timer)
    io.to(session.callerSocketId).emit('call:accepted', { callId, receiverSocketId: socket.id })
    acknowledge?.({ ok: true })
  })
  socket.on('call:signal', ({ callId, signal }) => {
    const session = callSessions.get(callId)
    if (!session || !signal) return
    const target = session.callerSocketId === socket.id ? session.calleeSocketId
      : session.calleeSocketId === socket.id ? session.callerSocketId : null
    if (target) io.to(target).emit('call:signal', { callId, fromSocketId: socket.id, signal })
  })
  socket.on('call:decline', ({ callId }) => {
    const session = callSessions.get(callId)
    if (!session || session.calleeId !== userId) return
    finishCall(callId, 'declined')
  })
  socket.on('call:end', ({ callId }) => {
    const session = callSessions.get(callId)
    if (!session) return
    if (session.callerSocketId !== socket.id && session.calleeSocketId !== socket.id) return
    finishCall(callId, 'ended')
  })
  socket.on('disconnect', async () => {
    const abandoned = sessionForSocket(socket.id)
    if (abandoned) finishCall(abandoned.callId, 'disconnected')
    const count = (onlineUsers.get(userId) || 1) - 1
    if (count > 0) return onlineUsers.set(userId, count)
    onlineUsers.delete(userId)
    socketMessageTimes.delete(userId)
    // A callee who drops while a call is still ringing leaves no socket id on the
    // session, so match by user as well.
    const ringing = [...callSessions.values()].find((session) => session.calleeId === userId && !session.calleeSocketId)
    if (ringing) finishCall(ringing.callId, 'disconnected')
    try { await query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]) } catch { /* Best effort presence update. */ }
    broadcastPresence(userId, { online: false, lastSeenAt: new Date().toISOString() })  })
})

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === 'LIMIT_FILE_SIZE'
    return response.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'That file is too large. Try a smaller one.' : 'That upload could not be accepted.',
    })
  }
  console.error(error)
  response.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong.', ...(error.code ? { code: error.code } : {}) })
})

httpServer.listen(PORT, () => console.log(`Chat API and Socket.IO server listening on http://localhost:${PORT}`))

// Expired statuses are removed from disk as well as from the database.
// Object deletions that failed (network or credentials) are retried, and
// abandoned upload scratch files are removed.
async function retryPendingMediaDeletes() {
  const { rows } = await query(`SELECT id, storage_provider, object_key FROM media_objects
    WHERE status = 'pending_delete' AND delete_error IS NOT NULL AND delete_attempts < 10
    ORDER BY delete_requested_at NULLS LAST LIMIT 50`)
  for (const object of rows) {
    try {
      await storage.deleteObject({ provider: object.storage_provider, key: object.object_key })
      await query(`UPDATE media_objects SET status = 'deleted', delete_error = NULL WHERE id = $1`, [object.id])
    } catch (error) {
      await query(`UPDATE media_objects SET delete_error = $2, delete_attempts = delete_attempts + 1 WHERE id = $1`,
        [object.id, error.message]).catch(() => {})
    }
  }
}

async function cleanupUploadScratch() {
  const cutoff = Date.now() - 60 * 60 * 1000
  const entries = await fs.promises.readdir(uploadTempDirectory).catch(() => [])
  for (const name of entries) {
    const file = path.join(uploadTempDirectory, name)
    const stat = await fs.promises.stat(file).catch(() => null)
    if (stat?.isFile() && stat.mtimeMs < cutoff) await fs.promises.unlink(file).catch(() => {})
  }
}

setInterval(async () => {
  try {
    const { rows } = await query(`DELETE FROM statuses WHERE created_at < NOW() - INTERVAL '24 hours' RETURNING media_url`)
    for (const row of rows) await deleteStoredFile(row.media_url)
  } catch (error) { console.error('Status cleanup failed:', error.message) }
  await retryPendingMediaDeletes().catch((error) => console.error('Media delete retry failed:', error.message))
  await cleanupUploadScratch().catch((error) => console.error('Upload scratch cleanup failed:', error.message))
}, 60 * 60 * 1000).unref()
