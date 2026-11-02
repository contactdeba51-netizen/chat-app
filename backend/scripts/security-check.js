// Security regression check for the deployed/local API.
//
//   npm run security:check
//   SECURITY_BASE_URL=https://chat-app-api-ku3h.onrender.com npm run security:check
//
// It needs DATABASE_URL for the same database the API uses, because it seeds
// throwaway accounts and reads counters directly. Socket.IO authorization is
// exercised separately from REST: every socket test connects with its own
// handshake token rather than reusing a REST session.
require('dotenv').config()

const path = require('node:path')
const bcrypt = require('bcryptjs')
const { Client } = require('pg')
// socket.io-client already ships with the frontend; reuse it instead of adding
// a second copy to the backend for a developer-only check.
const { io } = require(path.join(__dirname, '..', '..', 'frontend', 'node_modules', 'socket.io-client'))

const BASE = String(process.env.SECURITY_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '')
const API = `${BASE}/api`
const PASSWORD = 'SecurityCheck123!'
const PIN = '4321'
const db = new Client({ connectionString: process.env.DATABASE_URL })

let pass = 0
let fail = 0
const check = (label, ok, details = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` :: ${details}`}`)
}

async function api(pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, data: await response.json().catch(() => null) }
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 8000 })
    const timer = setTimeout(() => { socket.close(); reject(new Error('connect timeout')) }, 10_000)
    socket.on('connect', () => { clearTimeout(timer); resolve(socket) })
    socket.on('connect_error', (error) => { clearTimeout(timer); socket.close(); reject(error) })
  })
}

async function expectSocketRejected(token) {
  try {
    const socket = await connect(token)
    socket.close()
    return false
  } catch {
    return true
  }
}

function request(socket, event, payload, timeout = 8000) {
  return new Promise((resolve) => socket.timeout(timeout).emit(event, payload, (error, result) => resolve({ error: error ? String(error) : null, result })))
}

async function seed(tag, displayName) {
  const email = `seccheck.${tag}.${Date.now()}@example.com`
  const passwordHash = await bcrypt.hash(PASSWORD, 10)
  const { rows } = await db.query(`INSERT INTO users (email, password_hash, display_name, email_verified_at)
    VALUES ($1, $2, $3, NOW()) RETURNING *`, [email, passwordHash, displayName])
  const login = await api('/auth/login', { method: 'POST', body: { identifier: email, password: PASSWORD } })
  if (!login.data?.token) throw new Error(`unable to sign in ${tag}: ${JSON.stringify(login.data)}`)
  return { user: rows[0], email, token: login.data.token }
}

async function cleanup() {
  await db.query("DELETE FROM users WHERE email LIKE 'seccheck.%@example.com'")
}

async function main() {
  await db.connect()
  await cleanup()

  const alice = await seed('a', 'Security Alice')
  const bob = await seed('b', 'Security Bob')
  const outsider = await seed('c', 'Security Outsider')

  const pair = [alice.user.id, bob.user.id].sort()
  const { rows: chats } = await db.query(`INSERT INTO chats (type, user_one_id, user_two_id) VALUES ('direct', $1, $2) RETURNING *`,
    [pair[0], pair[1]])
  const chatId = chats[0].id

  // --- Socket.IO handshake authorization, independent of REST ----------------
  check('socket rejects a connection with no token', await expectSocketRejected(undefined))
  check('socket rejects a forged token', await expectSocketRejected('not-a-real-token'))
  const aliceRest = await api('/auth/me', { token: alice.token })
  check('REST accepts the same valid token the socket will use', aliceRest.status === 200, JSON.stringify(aliceRest.data))
  const socketAlice = await connect(alice.token)
  check('socket accepts a valid token', socketAlice.connected)
  const socketBob = await connect(bob.token)
  const socketOutsider = await connect(outsider.token)

  // Token version changes are the password-reset revocation path. Both
  // transports must reject the old token, and the socket must re-check it on
  // handshake rather than trusting the REST cookie.
  await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [alice.user.id])
  const revokedRest = await api('/auth/me', { token: alice.token })
  check('REST rejects a revoked token', revokedRest.status === 401, String(revokedRest.status))
  check('socket rejects a revoked token', await expectSocketRejected(alice.token))
  await db.query('UPDATE users SET token_version = token_version - 1 WHERE id = $1', [alice.user.id])

  // --- Membership is enforced on socket events too ---------------------------
  const joinAsOutsider = await request(socketOutsider, 'chat:join', { chatId })
  check('outsider cannot join a socket chat room', joinAsOutsider.result?.ok === false, JSON.stringify(joinAsOutsider.result))
  const sendAsOutsider = await request(socketOutsider, 'message:send', { chatId, text: 'outsider' })
  check('outsider cannot send a socket message', sendAsOutsider.result?.ok === false, JSON.stringify(sendAsOutsider.result))
  check('outsider REST read is refused', (await api(`/chats/${chatId}/messages`, { token: outsider.token })).status === 404)

  // --- Locked-chat access cannot be bypassed ---------------------------------
  const seedMessage = await api(`/chats/${chatId}/messages`, { method: 'POST', token: alice.token, body: { text: 'seed message' } })
  const messageId = seedMessage.data?.message?.id
  check('seed message created while unlocked', seedMessage.status === 201 && Boolean(messageId))
  const { rows: bobMessages } = await db.query(`INSERT INTO messages (chat_id, sender_id, body) VALUES ($1, $2, 'from bob') RETURNING id`, [chatId, bob.user.id])
  const bobMessageId = bobMessages[0].id

  const lock = await api(`/chats/${chatId}/preferences`, { method: 'PATCH', token: alice.token, body: { locked: true, pin: PIN } })
  check('owner can lock the chat', lock.status === 200 && lock.data?.locked === true, JSON.stringify(lock.data))

  const before = await db.query('SELECT COUNT(*)::int AS count FROM messages WHERE chat_id = $1', [chatId])
  const messageCount = before.rows[0].count

  const cases = [
    ['GET messages', await api(`/chats/${chatId}/messages`, { token: alice.token })],
    ['POST message', await api(`/chats/${chatId}/messages`, { method: 'POST', token: alice.token, body: { text: 'bypass' } })],
    ['PATCH message', await api(`/messages/${messageId}`, { method: 'PATCH', token: alice.token, body: { text: 'bypass edit' } })],
    ['DELETE message', await api(`/messages/${messageId}`, { method: 'DELETE', token: alice.token })],
    ['forward message', await api(`/messages/${messageId}/forward`, { method: 'POST', token: alice.token, body: { targetChatId: chatId } })],
    ['react to message', await api(`/messages/${bobMessageId}/reactions`, { method: 'POST', token: alice.token, body: { emoji: '👍' } })],
    ['read receipts', await api(`/chats/${chatId}/read`, { method: 'POST', token: alice.token })],
    ['attachment upload', await api(`/chats/${chatId}/attachments`, { method: 'POST', token: alice.token })],
  ]
  for (const [label, result] of cases) {
    check(`REST ${label} is refused while locked`, result.status === 403 && result.data?.code === 'CHAT_LOCKED', `${result.status} ${JSON.stringify(result.data)}`)
  }

  const socketSend = await request(socketAlice, 'message:send', { chatId, text: 'socket bypass' })
  check('socket message:send is refused while locked', socketSend.result?.ok === false && /locked/i.test(socketSend.result?.error || ''), JSON.stringify(socketSend.result))
  const socketJoin = await request(socketAlice, 'chat:join', { chatId })
  check('socket chat:join is refused while locked', socketJoin.result?.ok === false, JSON.stringify(socketJoin.result))
  const socketCall = await request(socketAlice, 'call:request', { chatId, callId: `seccheck-${Date.now()}`, type: 'audio' })
  check('socket call:request is refused while locked', socketCall.result?.ok === false && /locked/i.test(socketCall.result?.error || ''), JSON.stringify(socketCall.result))

  let typingLeaked = false
  socketBob.on('chat:typing', () => { typingLeaked = true })
  socketAlice.emit('chat:typing', { chatId, isTyping: true })
  await new Promise((resolve) => setTimeout(resolve, 800))
  check('socket chat:typing does not leak from a locked chat', typingLeaked === false)

  const after = await db.query('SELECT COUNT(*)::int AS count FROM messages WHERE chat_id = $1', [chatId])
  check('no message was written by any bypass attempt', after.rows[0].count === messageCount, `${messageCount} -> ${after.rows[0].count}`)
  const receipts = await db.query(`SELECT COUNT(*)::int AS count FROM message_receipts r JOIN messages m ON m.id = r.message_id
    WHERE m.chat_id = $1 AND r.user_id = $2`, [chatId, alice.user.id])
  check('no read receipt was written without unlocking', receipts.rows[0].count === 0, String(receipts.rows[0].count))

  // --- The legitimate path still works --------------------------------------
  const unlock = await api(`/chats/${chatId}/unlock`, { method: 'POST', token: alice.token, body: { pin: PIN } })
  check('correct PIN returns an unlock token', unlock.status === 200 && Boolean(unlock.data?.token), JSON.stringify(unlock.data))
  const unlocked = await api(`/chats/${chatId}/messages`, { token: alice.token, headers: { 'x-chat-unlock': unlock.data.token } })
  check('messages are readable with the unlock token', unlocked.status === 200, String(unlocked.status))
  const read = await api(`/chats/${chatId}/read`, { method: 'POST', token: alice.token, headers: { 'x-chat-unlock': unlock.data.token } })
  check('read receipts work with the unlock token', read.status === 204, String(read.status))
  const unlockedSocket = await request(socketAlice, 'message:send', { chatId, text: 'after unlock', unlockToken: unlock.data.token })
  check('socket message:send works with the unlock token', unlockedSocket.result?.ok === true, JSON.stringify(unlockedSocket.result))

  socketAlice.close()
  socketBob.close()
  socketOutsider.close()
  await cleanup()
  console.log(`\n${pass} passed, ${fail} failed`)
  await db.end()
  process.exit(fail ? 1 : 0)
}

main().catch(async (error) => {
  console.error('CHECK CRASHED:', error.message)
  try { await cleanup() } catch { /* ignore */ }
  try { await db.end() } catch { /* ignore */ }
  process.exit(1)
})
