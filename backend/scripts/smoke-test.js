// End-to-end API smoke test. Requires the backend and PostgreSQL to be running.
// Accounts are seeded directly in PostgreSQL as verified users, because sign-up
// itself needs a real email provider (Brevo). Run: node scripts/smoke-test.js
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const { Client } = require('pg')
const storage = require('../src/storage')

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:5000/api'
// Origin used for the media checks; must match the server under test so a
// remote deployment can be verified without pointing at localhost.
const ORIGIN = process.env.SMOKE_ORIGIN || BASE.replace(/\/api$/, '')
const PASSWORD = 'Password123!'
const db = new Client({ connectionString: process.env.DATABASE_URL })

let passed = 0
let failed = 0

function check(label, condition, details = '') {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${details ? ` :: ${details}` : ''}`)
  }
}

async function request(path, { method = 'GET', token, body, form, headers: extraHeaders } = {}) {
  const headers = { ...extraHeaders }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined),
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { status: response.status, data }
}

async function seedUser({ email, phone, displayName }) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10)
  const { rows } = await db.query(`INSERT INTO users (email, password_hash, display_name, phone, phone_country, email_verified_at)
    VALUES ($1, $2, $3, $4, 'US', NOW()) RETURNING *`, [email, passwordHash, displayName, phone])
  return rows[0]
}

async function cleanup() {
  const { rows: testUsers } = await db.query(`SELECT id FROM users WHERE email LIKE 'smoke.%@example.com'`)
  if (testUsers.length) {
    const ids = testUsers.map((user) => user.id)
    // Direct SQL deletion would otherwise leave the media rows and their bytes
    // behind, because media_objects.owner_id is ON DELETE SET NULL.
    const { rows: objects } = await db.query(`SELECT storage_provider, object_key FROM media_objects
      WHERE owner_id = ANY($1::uuid[])`, [ids])
    for (const object of objects) {
      await storage.deleteObject({ provider: object.storage_provider, key: object.object_key }).catch(() => {})
    }
    await db.query('DELETE FROM media_objects WHERE owner_id = ANY($1::uuid[])', [ids])
  }
  await db.query(`DELETE FROM users WHERE email LIKE 'smoke.%@example.com'`)
  await db.query(`DELETE FROM pending_signups WHERE email LIKE 'smoke.%@example.com'`)
  // Groups have nullable owners; remove any that lost every member.
  await db.query(`DELETE FROM chats c WHERE c.type = 'group'
    AND NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.chat_id = c.id)`)
}

async function main() {
  await db.connect()
  await cleanup()

  const stamp = Date.now()
  // Numbers stay inside the 202-555-xxxx test range so libphonenumber always accepts them.
  const tag = String(stamp).slice(-3)
  const alicePhone = `+1202555${tag}1`
  const bobPhone = `+1202555${tag}2`
  const inviteePhone = `+1202555${tag}3`
  const aliceEmail = `smoke.alice.${stamp}@example.com`
  const bobEmail = `smoke.bob.${stamp}@example.com`
  const inviteeEmail = `smoke.invitee.${stamp}@example.com`

  try {
    const health = await request('/health')
    check('health endpoint', health.status === 200 && health.data.status === 'ok')

    const alice = await seedUser({ email: aliceEmail, phone: alicePhone, displayName: 'Alice Smoke' })
    const bob = await seedUser({ email: bobEmail, phone: bobPhone, displayName: 'Bob Smoke' })

    const invalidPhone = await request('/auth/register/start', { method: 'POST', body: { country: 'US', phone: '123', displayName: 'Nope', email: 'smoke.invalid@example.com', password: PASSWORD } })
    check('invalid phone rejected at signup', invalidPhone.status === 400, `status=${invalidPhone.status}`)

    if (!process.env.BREVO_API_KEY) {
      const noProvider = await request('/auth/register/start', { method: 'POST', body: { country: 'US', phone: '+12025550111', displayName: 'No Provider', email: 'smoke.noprovider@example.com', password: PASSWORD } })
      check('signup blocked without email provider', noProvider.status === 503, `status=${noProvider.status}`)
    }

    const aliceLogin = await request('/auth/login', { method: 'POST', body: { identifier: alicePhone, country: 'US', password: PASSWORD } })
    check('login by phone', aliceLogin.status === 200 && Boolean(aliceLogin.data.token), JSON.stringify(aliceLogin.data))
    const aliceToken = aliceLogin.data.token
    check('signup identity returns phone', String(aliceLogin.data.user.phone || '').startsWith('+1'))
    check('email marked verified', aliceLogin.data.user.emailVerified === true)

    const emailLogin = await request('/auth/login', { method: 'POST', body: { identifier: aliceEmail, password: PASSWORD } })
    check('login by email still works', emailLogin.status === 200 && Boolean(emailLogin.data.token))

    const bobLogin = await request('/auth/login', { method: 'POST', body: { identifier: bobPhone, country: 'US', password: PASSWORD } })
    check('login Bob by phone', bobLogin.status === 200 && Boolean(bobLogin.data.token))
    const bobToken = bobLogin.data.token

    const badLogin = await request('/auth/login', { method: 'POST', body: { identifier: alicePhone, country: 'US', password: 'WrongPassword1!' } })
    check('wrong password rejected', badLogin.status === 401)

    const me = await request('/auth/me', { token: aliceToken })
    check('authenticated /me', me.status === 200 && me.data.user.displayName === 'Alice Smoke')

    // Per-tab sessions: the tab's bearer token must win over any shared cookie,
    // otherwise signing in as another account in a second tab hijacks the first.
    const tabbedSession = await request('/auth/me', { token: aliceToken, headers: { Cookie: `chat_access_token=${bobToken}` } })
    check('bearer session wins over a shared cookie', tabbedSession.status === 200 && tabbedSession.data.user.id === alice.id, JSON.stringify(tabbedSession.data))

    const unauthenticated = await request('/chats')
    check('unauthenticated chats rejected', unauthenticated.status === 401)

    const profile = await request('/users/me', { method: 'PATCH', token: aliceToken, body: { displayName: 'Alice Updated', bio: 'Phase 1 test' } })
    check('profile update', profile.status === 200 && profile.data.user.displayName === 'Alice Updated')

    const privacy = await request('/users/me/privacy', { method: 'PATCH', token: aliceToken, body: { lastSeenVisible: false } })
    check('privacy update', privacy.status === 200 && privacy.data.lastSeenVisible === false)

    const wrongType = new FormData()
    wrongType.append('avatar', new Blob(['not an image'], { type: 'text/plain' }), 'note.txt')
    const rejectedUpload = await request('/users/me/avatar', { method: 'POST', token: aliceToken, form: wrongType })
    check('wrong upload type rejected clearly', rejectedUpload.status === 400 && /image/i.test(String(rejectedUpload.data?.error)), `status=${rejectedUpload.status}`)

    const oversized = new FormData()
    oversized.append('avatar', new Blob([Buffer.alloc(6 * 1024 * 1024)], { type: 'image/png' }), 'big.png')
    const tooBig = await request('/users/me/avatar', { method: 'POST', token: aliceToken, form: oversized })
    check('oversized upload rejected with 413', tooBig.status === 413, `status=${tooBig.status}`)

    const addBob = await request('/contacts', { method: 'POST', token: aliceToken, body: { country: 'US', phone: bobPhone } })
    check('add contact by phone', addBob.status === 201 && Boolean(addBob.data.chat?.id), JSON.stringify(addBob.data))
    const chatId = addBob.data.chat.id

    const aliceContacts = await request('/contacts', { token: aliceToken })
    const bobContact = aliceContacts.data.contacts.find((contact) => contact.phone === bobPhone)
    check('contact saved and resolved', Boolean(bobContact?.registered) && bobContact?.chatId === chatId)
    check('adding own number rejected', (await request('/contacts', { method: 'POST', token: aliceToken, body: { country: 'US', phone: alicePhone } })).status === 400)

    const bobChats = await request('/chats', { token: bobToken })
    check('Bob sees the new chat', bobChats.data.some((chat) => chat.id === chatId))

    const invite = await request('/contacts', { method: 'POST', token: aliceToken, body: { country: 'US', phone: inviteePhone, displayName: 'Future Friend' } })
    check('unregistered number creates invite', invite.status === 201 && invite.data.pending === true && String(invite.data.inviteUrl).includes('/?phone='), JSON.stringify(invite.data))
    check('WhatsApp invite link built', String(invite.data.whatsappUrl || '').startsWith('https://wa.me/'))

    const pendingContact = (await request('/contacts', { token: aliceToken })).data.contacts.find((contact) => contact.phone === inviteePhone)
    check('pending contact is visible', Boolean(pendingContact) && pendingContact.registered === false)

    const invitee = await seedUser({ email: inviteeEmail, phone: inviteePhone, displayName: 'Future Friend' })
    const inviteeLogin = await request('/auth/login', { method: 'POST', body: { identifier: inviteePhone, country: 'US', password: PASSWORD } })
    const inviteeChats = await request('/chats', { token: inviteeLogin.data.token })
    const invitationChat = inviteeChats.data.find((chat) => chat.otherUserId === alice.id)
    check('invite creates a chat after signup', Boolean(invitationChat))
    check('invite delivers an invitation message', invitationChat?.messages.some((message) => message.senderId === alice.id && message.text.includes('I added you')))
    const resolvedContact = (await request('/contacts', { token: aliceToken })).data.contacts.find((contact) => contact.phone === inviteePhone)
    check('pending contact resolves after signup', Boolean(resolvedContact?.registered) && Boolean(resolvedContact?.chatId))

    await request('/users/me/privacy', { method: 'PATCH', token: bobToken, body: { findableByPhone: false } })
    await request(`/contacts/${encodeURIComponent(bobPhone)}`, { method: 'DELETE', token: aliceToken })
    const hidden = await request('/contacts', { method: 'POST', token: aliceToken, body: { country: 'US', phone: bobPhone } })
    check('hidden phone cannot be added', hidden.status === 404, `status=${hidden.status}`)
    await request('/users/me/privacy', { method: 'PATCH', token: bobToken, body: { findableByPhone: true } })
    const readd = await request('/contacts', { method: 'POST', token: aliceToken, body: { country: 'US', phone: bobPhone } })
    check('contact can be re-added', readd.status === 201 && Boolean(readd.data.chat?.id))

    const carolPhone = `+1202555${tag}4`
    const carol = await seedUser({ email: `smoke.carol.${stamp}@example.com`, phone: carolPhone, displayName: 'Carol Smoke' })
    const carolLogin = await request('/auth/login', { method: 'POST', body: { identifier: carolPhone, country: 'US', password: PASSWORD } })
    const carolToken = carolLogin.data.token
    await request('/users/me/privacy', { method: 'PATCH', token: carolToken, body: { contactPermission: 'contacts' } })
    const blockedByPermission = await request('/contacts', { method: 'POST', token: aliceToken, body: { country: 'US', phone: carolPhone } })
    check('contacts-only privacy blocks strangers', blockedByPermission.status === 403, `status=${blockedByPermission.status}`)
    const carolAddsAlice = await request('/contacts', { method: 'POST', token: carolToken, body: { country: 'US', phone: alicePhone } })
    check('contacts-only user can message someone they add', carolAddsAlice.status === 201 && Boolean(carolAddsAlice.data.chat?.id), JSON.stringify(carolAddsAlice.data))
    const allowedNow = await request('/contacts', { method: 'POST', token: aliceToken, body: { country: 'US', phone: carolPhone } })
    check('contact allowed once a chat exists', allowedNow.status === 201 && Boolean(allowedNow.data.chat?.id))
    check('Carol is linked to Alice', Boolean(carol?.id))

    // Status visibility: author, saved contacts, and chat partners only.
    await request('/statuses', { method: 'POST', token: carolToken, body: { text: 'Carol private status' } })
    const statusesForAlice = await request('/statuses', { token: aliceToken })
    check('status visible to a chat partner', statusesForAlice.data.some((status) => status.text === 'Carol private status'))
    const statusesForBob = await request('/statuses', { token: bobToken })
    check('status hidden from strangers', !statusesForBob.data.some((status) => status.text === 'Carol private status'))

    const sent = await request(`/chats/${chatId}/messages`, { method: 'POST', token: aliceToken, body: { text: 'Hello from the smoke test' } })
    check('send message', sent.status === 201 && sent.data.message.text === 'Hello from the smoke test')
    const messageId = sent.data.message.id

    const bobChatAfter = (await request('/chats', { token: bobToken })).data.find((item) => item.id === chatId)
    check('Bob has an unread count', bobChatAfter?.unread === 1, `unread=${bobChatAfter?.unread}`)

    const read = await request(`/chats/${chatId}/read`, { method: 'POST', token: bobToken })
    check('Bob marks chat read', read.status === 204)

    const aliceChat = (await request('/chats', { token: aliceToken })).data.find((item) => item.id === chatId)
    check('Alice sees read receipt', Boolean(aliceChat?.messages.find((message) => message.id === messageId)?.readAt))

    // Media: uploads are served only through signed, expiring URLs.
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const avatarForm = new FormData()
    avatarForm.append('avatar', new Blob([pixel], { type: 'image/png' }), 'dot.png')
    const avatarUpload = await request('/users/me/avatar', { method: 'POST', token: aliceToken, form: avatarForm })
    check('avatar upload returns a signed URL', avatarUpload.status === 200 && String(avatarUpload.data.user.avatarUrl).startsWith('/api/media/'), JSON.stringify(avatarUpload.data))
    const signedUrl = `${ORIGIN}${avatarUpload.data.user.avatarUrl}`
    const signedResponse = await fetch(signedUrl)
    check('signed media is served', signedResponse.status === 200 && String(signedResponse.headers.get('content-type')).includes('image/png'))
    check('unsigned media path is gone', (await fetch(`${ORIGIN}/uploads/${avatarUpload.data.user.avatarUrl.split('/')[3].split('?')[0]}`)).status === 404)
    check('tampered media signature is rejected', (await fetch(signedUrl.replace(/signature=[a-f0-9]+/, 'signature=0'.repeat(64)))).status === 403)

    const secondAvatarForm = new FormData()
    secondAvatarForm.append('avatar', new Blob([pixel], { type: 'image/png' }), 'dot2.png')
    const secondAvatar = await request('/users/me/avatar', { method: 'POST', token: aliceToken, form: secondAvatarForm })
    check('replacing an avatar works', secondAvatar.status === 200 && secondAvatar.data.user.avatarUrl !== avatarUpload.data.user.avatarUrl)
    check('replaced avatar media is revoked', (await fetch(signedUrl)).status === 410)

    const attachmentForm = new FormData()
    attachmentForm.append('file', new Blob([pixel], { type: 'image/png' }), 'chat.png')
    const attachment = await request(`/chats/${chatId}/attachments`, { method: 'POST', token: aliceToken, form: attachmentForm })
    check('chat attachment upload', attachment.status === 201 && String(attachment.data.path).startsWith('/uploads/'), JSON.stringify(attachment.data))
    const storage = await request('/users/me/storage', { token: aliceToken })
    check('storage usage reports quota', storage.status === 200 && storage.data.usedBytes > 0 && storage.data.quotaBytes > 0, JSON.stringify(storage.data))
    const photoMessage = await request(`/chats/${chatId}/messages`, { method: 'POST', token: aliceToken, body: { image: attachment.data.path } })
    check('message accepts an uploaded photo', photoMessage.status === 201 && String(photoMessage.data.message.image).startsWith('/api/media/'))
    const inlineImage = await request(`/chats/${chatId}/messages`, { method: 'POST', token: aliceToken, body: { image: 'data:image/png;base64,AAAA' } })
    check('inline data images rejected', inlineImage.status === 400, `status=${inlineImage.status}`)

    const privateForm = new FormData()
    privateForm.append('file', new Blob([pixel], { type: 'image/png' }), 'private.png')
    const privateUpload = await request(`/chats/${chatId}/attachments`, { method: 'POST', token: aliceToken, form: privateForm })
    const stolenPhoto = await request(`/chats/${chatId}/messages`, { method: 'POST', token: bobToken, body: { image: privateUpload.data.path } })
    check('another user\'s unattached photo is rejected', stolenPhoto.status === 403, `status=${stolenPhoto.status}`)

    const outsiderForm = new FormData()
    outsiderForm.append('file', new Blob([pixel], { type: 'image/png' }), 'chat.png')
    check('non-members cannot upload attachments', (await request(`/chats/${chatId}/attachments`, { method: 'POST', token: carolToken, form: outsiderForm })).status === 404)

    // Receipts: listing chats must not claim delivery.
    const offlineMessage = await request(`/chats/${chatId}/messages`, { method: 'POST', token: aliceToken, body: { text: 'Sent while Bob is away' } })
    check('offline message is not marked delivered', offlineMessage.data.message.deliveredAt === null, JSON.stringify(offlineMessage.data.message.deliveredAt))
    await request('/chats', { token: bobToken })
    const afterChatList = await request(`/chats/${chatId}/messages`, { token: aliceToken })
    check('loading the chat list does not fake delivery', afterChatList.data.find((item) => item.id === offlineMessage.data.message.id)?.deliveredAt === null)
    check('call history endpoint responds', (await request('/calls', { token: aliceToken })).status === 200)

    const edited = await request(`/messages/${messageId}`, { method: 'PATCH', token: aliceToken, body: { text: 'Edited message' } })
    check('edit message', edited.status === 200 && edited.data.text === 'Edited message' && Boolean(edited.data.editedAt))

    const reaction = await request(`/messages/${messageId}/reactions`, { method: 'POST', token: bobToken, body: { emoji: '👍' } })
    check('react to message', reaction.status === 201 && reaction.data.reactions.some((item) => item.emoji === '👍'))

    const starred = await request(`/messages/${messageId}/star`, { method: 'POST', token: bobToken })
    check('star message', starred.status === 201 && starred.data.starred === true)
    const unstarred = await request(`/messages/${messageId}/star`, { method: 'DELETE', token: bobToken })
    check('unstar message', unstarred.status === 200 && unstarred.data.starred === false)

    const reply = await request(`/chats/${chatId}/messages`, { method: 'POST', token: bobToken, body: { text: 'Replying', replyToId: messageId } })
    check('reply to message', reply.status === 201 && reply.data.message.replyTo?.id === messageId)

    const searchMessages = await request('/search?query=Edited', { token: bobToken })
    check('message search', searchMessages.status === 200 && searchMessages.data.messages.some((item) => item.id === messageId))

    // Locked chats: content stays on the server until the PIN is verified.
    check('locking requires a PIN', (await request(`/chats/${chatId}/preferences`, { method: 'PATCH', token: aliceToken, body: { locked: true } })).status === 400)
    const locked = await request(`/chats/${chatId}/preferences`, { method: 'PATCH', token: aliceToken, body: { locked: true, pin: '1234' } })
    check('chat can be locked with a PIN', locked.status === 200 && locked.data.locked === true && locked.data.has_pin === true, JSON.stringify(locked.data))
    check('locked chat still hides its PIN hash', !('lock_pin_hash' in (locked.data || {})))

    check('locked messages are withheld', (await request(`/chats/${chatId}/messages`, { token: aliceToken })).status === 403)
    check('PIN cannot be changed while locked', (await request(`/chats/${chatId}/preferences`, { method: 'PATCH', token: aliceToken, body: { pin: '5678' } })).status === 400)
    const lockedList = (await request('/chats', { token: aliceToken })).data.find((item) => item.id === chatId)
    check('locked chat list hides messages and preview', lockedList?.locked === true && lockedList.messages.length === 0 && lockedList.lastMessage === 'Locked chat', JSON.stringify({ locked: lockedList?.locked, count: lockedList?.messages?.length }))
    const lockedSearch = await request('/search?query=Edited', { token: aliceToken })
    check('search skips locked chats', !lockedSearch.data.messages.some((item) => item.chatId === chatId))
    const lockedSend = await request(`/chats/${chatId}/messages`, { method: 'POST', token: aliceToken, body: { text: 'Should need the PIN' } })
    check('sending to a locked chat needs the PIN', lockedSend.status === 403, `status=${lockedSend.status}`)

    check('wrong PIN is rejected', (await request(`/chats/${chatId}/unlock`, { method: 'POST', token: aliceToken, body: { pin: '9999' } })).status === 403)
    const unlocked = await request(`/chats/${chatId}/unlock`, { method: 'POST', token: aliceToken, body: { pin: '1234' } })
    check('correct PIN returns an unlock token', unlocked.status === 200 && typeof unlocked.data.token === 'string', JSON.stringify(unlocked.data))
    const unlockedMessages = await request(`/chats/${chatId}/messages`, { token: aliceToken, headers: { 'x-chat-unlock': unlocked.data.token } })
    check('unlock token reveals messages', unlockedMessages.status === 200 && unlockedMessages.data.some((item) => item.id === messageId))
    const unlockedSend = await request(`/chats/${chatId}/messages`, { method: 'POST', token: aliceToken, body: { text: 'Unlocked message', unlockToken: unlocked.data.token } })
    check('unlock token allows sending', unlockedSend.status === 201, `status=${unlockedSend.status}`)
    check('tampered unlock token is rejected', (await request(`/chats/${chatId}/messages`, { token: aliceToken, headers: { 'x-chat-unlock': '9999999999.' + '0'.repeat(64) } })).status === 403)
    check('the other participant still sees their messages', ((await request('/chats', { token: bobToken })).data.find((item) => item.id === chatId)?.messages.length || 0) > 0)

    check('wrong PIN cannot unlock the chat', (await request(`/chats/${chatId}/preferences`, { method: 'PATCH', token: aliceToken, body: { locked: false, pin: '0000' } })).status === 403)
    const relockedList = (await request('/chats', { token: aliceToken })).data.find((item) => item.id === chatId)
    check('failed unlock keeps the chat locked', relockedList?.locked === true)
    const unlockedPrefs = await request(`/chats/${chatId}/preferences`, { method: 'PATCH', token: aliceToken, body: { locked: false, pin: '1234' } })
    check('chat can be unlocked with the PIN', unlockedPrefs.status === 200 && unlockedPrefs.data.locked === false)
    const restoredList = (await request('/chats', { token: aliceToken })).data.find((item) => item.id === chatId)
    check('unlocked chat restores its messages', restoredList?.messages.some((item) => item.id === messageId), `count=${restoredList?.messages?.length}`)

    const archived = await request(`/chats/${chatId}/preferences`, { method: 'PATCH', token: aliceToken, body: { archived: true } })
    check('archive chat', archived.status === 200 && archived.data.archived === true)

    const blocked = await request(`/users/${bob.id}/block`, { method: 'POST', token: aliceToken })
    check('block user', blocked.status === 204)

    const blockedSend = await request(`/chats/${chatId}/messages`, { method: 'POST', token: bobToken, body: { text: 'Should fail' } })
    check('blocked user cannot message', blockedSend.status === 403, `status=${blockedSend.status}`)

    const unblocked = await request(`/users/${bob.id}/block`, { method: 'DELETE', token: aliceToken })
    check('unblock user', unblocked.status === 204)

    const deleted = await request(`/messages/${messageId}`, { method: 'DELETE', token: aliceToken })
    check('delete message', deleted.status === 204)

    const afterDelete = await request(`/chats/${chatId}/messages`, { token: bobToken })
    const deletedMessage = afterDelete.data.find((message) => message.id === messageId)
    check('deleted message is tombstoned', deletedMessage?.deletedAt && deletedMessage?.text === 'This message was deleted.')

    // Message window regression: newest 100 first, older pages via the cursor.
    await db.query(`WITH base AS (SELECT COALESCE(MAX(created_at), NOW()) AS t FROM messages WHERE chat_id = $1)
      INSERT INTO messages (chat_id, sender_id, body, created_at)
      SELECT $1, $2, 'Bulk ' || i, base.t + make_interval(secs => i) FROM generate_series(1, 105) i, base`, [chatId, alice.id])
    const window = await request(`/chats/${chatId}/messages`, { token: aliceToken })
    check('message window returns the newest 100', window.data.length === 100 && window.data.at(-1).text === 'Bulk 105', `count=${window.data.length} last=${window.data.at(-1)?.text}`)
    check('oldest messages are outside the first window', !window.data.some((message) => message.text === 'Edited message'))
    const older = await request(`/chats/${chatId}/messages?before=${encodeURIComponent(window.data[0].createdAt)}`, { token: aliceToken })
    check('older messages load with the cursor', older.data.length > 0 && older.data.some((message) => message.id === messageId), `count=${older.data.length}`)
    check('cursor page does not overlap the first window', !older.data.some((message) => message.id === window.data[0].id))
    check('invalid cursor rejected', (await request(`/chats/${chatId}/messages?before=not-a-date`, { token: aliceToken })).status === 400)

    // Groups share the chat pipeline: membership, messaging, receipts, replies,
    // and reactions all use the same endpoints.
    const group = await request('/groups', { method: 'POST', token: aliceToken, body: { name: 'Smoke Group', memberIds: [bob.id, carol.id] } })
    check('group created with selected members', group.status === 201 && group.data.group === true && group.data.memberCount === 3, JSON.stringify(group.data))
    const groupId = group.data.id
    const bobSeesGroup = (await request('/chats', { token: bobToken })).data.some((chat) => chat.id === groupId && chat.group)
    const carolSeesGroup = (await request('/chats', { token: carolToken })).data.some((chat) => chat.id === groupId && chat.group)
    check('group appears for every member', bobSeesGroup && carolSeesGroup)
    await request('/statuses', { method: 'POST', token: carolToken, body: { text: 'Group-only status' } })
    const bobStatuses = await request('/statuses', { token: bobToken })
    const inviteeStatuses = await request('/statuses', { token: inviteeLogin.data.token })
    check('group co-members see each other\'s statuses', bobStatuses.data.some((status) => status.text === 'Group-only status'))
    check('status stays hidden from non-group users', !inviteeStatuses.data.some((status) => status.text === 'Group-only status'))
    check('group requires a name', (await request('/groups', { method: 'POST', token: aliceToken, body: { name: '  ', memberIds: [bob.id] } })).status === 400)
    check('group rejects an empty member list', (await request('/groups', { method: 'POST', token: aliceToken, body: { name: 'Empty', memberIds: [] } })).status === 400)
    check('group rejects strangers', (await request('/groups', { method: 'POST', token: aliceToken, body: { name: 'Strangers', memberIds: [crypto.randomUUID()] } })).status === 400)
    const twoPerson = await request('/groups', { method: 'POST', token: aliceToken, body: { name: 'Pair', memberIds: [invitee.id] } })
    check('two-person group is allowed', twoPerson.status === 201 && twoPerson.data.memberCount === 2, JSON.stringify(twoPerson.data))

    const groupMessage = await request(`/chats/${groupId}/messages`, { method: 'POST', token: aliceToken, body: { text: 'Hello group' } })
    check('group message sent', groupMessage.status === 201 && Boolean(groupMessage.data.message?.id), JSON.stringify(groupMessage))
    const groupMessageId = groupMessage.data.message?.id
    const bobGroup = (await request('/chats', { token: bobToken })).data.find((chat) => chat.id === groupId)
    check('group message reaches members with sender name', Boolean(bobGroup?.messages.some((message) => message.id === groupMessageId && message.senderName === 'Alice Updated')))
    await request(`/chats/${groupId}/read`, { method: 'POST', token: bobToken })
    const aliceGroup = (await request('/chats', { token: aliceToken })).data.find((chat) => chat.id === groupId)
    check('group receipts update for the sender', Boolean(aliceGroup?.messages.find((message) => message.id === groupMessageId)?.readAt))
    const groupReply = await request(`/chats/${groupId}/messages`, { method: 'POST', token: carolToken, body: { text: 'Hi back', replyToId: groupMessageId } })
    check('group replies work', groupReply.status === 201 && groupReply.data.message?.replyTo?.text === 'Hello group', JSON.stringify(groupReply.data))
    const groupReaction = await request(`/messages/${groupMessageId}/reactions`, { method: 'POST', token: bobToken, body: { emoji: '👍' } })
    check('group reactions work', groupReaction.status === 201 && groupReaction.data.reactions?.some((reaction) => reaction.emoji === '👍'), `status=${groupReaction.status}`)
    check('non-members cannot read a group', (await request(`/chats/${groupId}/messages`, { token: inviteeLogin.data.token })).status === 404)
    check('non-members cannot post to a group', (await request(`/chats/${groupId}/messages`, { method: 'POST', token: inviteeLogin.data.token, body: { text: 'Intruder' } })).status === 404)

    const logout = await request('/auth/logout', { method: 'POST', token: bobToken })
    check('logout', logout.status === 204)

    // Account deletion removes the account and its data.
    const davePhone = `+1202555${tag}5`
    await seedUser({ email: `smoke.dave.${stamp}@example.com`, phone: davePhone, displayName: 'Dave Smoke' })
    const daveLogin = await request('/auth/login', { method: 'POST', body: { identifier: davePhone, country: 'US', password: PASSWORD } })
    const daveToken = daveLogin.data.token
    const daveChat = await request('/chats/direct', { method: 'POST', token: daveToken, body: { userId: alice.id } })
    await request(`/chats/${daveChat.data.id}/messages`, { method: 'POST', token: daveToken, body: { text: 'Goodbye' } })
    check('account deletion succeeds', (await request('/users/me', { method: 'DELETE', token: daveToken })).status === 204)
    check('deleted account cannot log in', (await request('/auth/login', { method: 'POST', body: { identifier: davePhone, country: 'US', password: PASSWORD } })).status === 401)
    check('deleted account token is rejected', (await request('/auth/me', { token: daveToken })).status === 401)

    // A password reset invalidates tokens issued before it.
    const erinPhone = `+1202555${tag}6`
    const erin = await seedUser({ email: `smoke.erin.${stamp}@example.com`, phone: erinPhone, displayName: 'Erin Smoke' })
    const erinLogin = await request('/auth/login', { method: 'POST', body: { identifier: erinPhone, country: 'US', password: PASSWORD } })
    const staleToken = erinLogin.data.token
    const resetToken = crypto.randomBytes(32).toString('hex')
    await db.query(`UPDATE users SET reset_token_hash = $1, reset_token_expires_at = NOW() + INTERVAL '1 hour' WHERE id = $2`,
      [crypto.createHash('sha256').update(resetToken).digest('hex'), erin.id])
    const reset = await request('/auth/reset-password', { method: 'POST', body: { token: resetToken, password: 'NewPassword123!' } })
    check('password reset returns a fresh session', reset.status === 200 && Boolean(reset.data.token), JSON.stringify(reset.data))
    check('pre-reset token is rejected', (await request('/auth/me', { token: staleToken })).status === 401)
    check('post-reset token works', (await request('/auth/me', { token: reset.data.token })).status === 200)

    // Stage 5A drill: deliberately false so CI proves it blocks a deploy when
    // verification fails. Remove after the drill; never merge to main.
    check('stage5a deliberate failure drill', false, 'intentional failure for the CI deployment gate drill')
  } finally {
    await cleanup().catch((error) => console.error('Cleanup failed:', error.message))
    await db.end()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch(async (error) => {
  console.error('Smoke test crashed:', error)
  try { await cleanup(); await db.end() } catch { /* Best effort cleanup. */ }
  process.exit(1)
})
