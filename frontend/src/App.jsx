import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'
const SERVER_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000'
const SESSION_KEY = 'chat-access-token'

// Sessions are per tab: sessionStorage keeps each tab signed in as its own
// account, while a shared cookie would silently merge every tab into one login.
function sessionToken() {
  try { return sessionStorage.getItem(SESSION_KEY) || '' } catch { return '' }
}

function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) }
  const token = sessionToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(`${API_URL}${path.startsWith('/') ? path : `/${path}`}`, { credentials: 'include', ...options, headers })
}

// Render's free tier stops the API after a period without traffic, so the first
// request of the day can fail before the instance wakes up: fetch itself throws a
// TypeError, or Render's proxy answers 502/503/504. Retry only those cases, and
// only for calls that are safe to repeat. A real HTTP error (401, 422) is
// returned immediately so the UI keeps showing the server's message.
const WAKE_RETRY_DELAYS_MS = [2000, 5000]

async function apiFetchWithWakeRetry(path, options = {}, onRetry) {
  for (let attempt = 0; ; attempt += 1) {
    let response
    try {
      response = await apiFetch(path, options)
    } catch (error) {
      if (!(error instanceof TypeError) || attempt >= WAKE_RETRY_DELAYS_MS.length) throw error
      onRetry?.(attempt)
      await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_DELAYS_MS[attempt]))
      continue
    }
    if (![502, 503, 504].includes(response.status) || attempt >= WAKE_RETRY_DELAYS_MS.length) return response
    onRetry?.(attempt)
    await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_DELAYS_MS[attempt]))
  }
}
const emojiChoices = ['😀', '😂', '😍', '🥳', '👍', '❤️', '🔥', '🙏', '😢', '🎉', '🤔', '✨']
const stickerChoices = ['😂', '❤️', '👍', '🔥', '🥳', '😎']
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
const flagFor = (iso) => [...iso].map((character) => String.fromCodePoint(127397 + character.charCodeAt(0))).join('')
const COUNTRIES = getCountries()
  .map((iso) => ({ iso, name: regionNames.of(iso) || iso, dialCode: `+${getCountryCallingCode(iso)}`, flag: flagFor(iso) }))
  .sort((left, right) => left.name.localeCompare(right.name))
const DEFAULT_COUNTRY = 'IN'
const dialCodeFor = (iso) => COUNTRIES.find((country) => country.iso === iso)?.dialCode || ''

function splitPhone(e164) {
  const parsed = parsePhoneNumberFromString(String(e164 || ''))
  if (!parsed) return { country: DEFAULT_COUNTRY, national: String(e164 || '').replace(/^\+/, '') }
  return { country: parsed.country || DEFAULT_COUNTRY, national: parsed.nationalNumber }
}

function CountryPicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = COUNTRIES.find((country) => country.iso === value) || COUNTRIES.find((country) => country.iso === DEFAULT_COUNTRY)
  const filtered = useMemo(() => {
    const term = search.toLowerCase().replace(/^\+/, '')
    return COUNTRIES.filter((country) => !term || country.name.toLowerCase().includes(term) || country.iso.toLowerCase().includes(term) || country.dialCode.replace('+', '').startsWith(term)).slice(0, 60)
  }, [search])
  return <div className="country-picker">
    <button type="button" className="country-toggle" onClick={() => setOpen((current) => !current)} aria-label="Choose country" aria-expanded={open}>
      <span>{selected.flag}</span><span>{selected.dialCode}</span><span aria-hidden="true">▾</span>
    </button>
    {open && <div className="country-menu">
      <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search country or code" aria-label="Search countries" />
      <div className="country-list">
        {filtered.map((country) => <button type="button" key={country.iso} className={country.iso === value ? 'active' : ''} onClick={() => { onChange(country.iso); setOpen(false); setSearch('') }}>
          <span>{country.flag} {country.name}</span><small>{country.dialCode}</small>
        </button>)}
        {!filtered.length && <p className="empty-search">No country found.</p>}
      </div>
    </div>}
  </div>
}


const formatTime = (value) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
const lastSeenLabel = (value) => {
  if (!value) return 'offline'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'offline'
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86_400_000)
  if (days === 0) return `last seen today at ${time}`
  if (days === 1) return `last seen yesterday at ${time}`
  return `last seen ${date.toLocaleDateString([], { day: '2-digit', month: 'short' })} at ${time}`
}
const mediaSrc = (value) => (value && String(value).startsWith('/') ? `${SERVER_URL}${value}` : value)
const normalizeMessage = (message, viewerId) => ({ ...message, time: message.time || formatTime(message.createdAt), starred: Boolean(message.starred), mine: typeof message.mine === 'boolean' ? message.mine : message.senderId === viewerId })
const normalizeChat = (chat, viewerId) => ({ ...chat, time: chat.time && !Number.isNaN(new Date(chat.time).getTime()) ? formatTime(chat.time) : chat.time, messages: (chat.messages || []).map((message) => normalizeMessage(message, viewerId)) })
const createId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`

function Avatar({ chat, large = false }) {
  const hasImage = Boolean(chat.avatarUrl)
  const style = hasImage
    ? { backgroundImage: `url(${SERVER_URL}${chat.avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { backgroundColor: chat.color }
  return <span className={`avatar ${large ? 'avatar-large' : ''}`} style={style}>{hasImage ? '' : chat.avatar}<i className={chat.online ? 'online-dot' : ''} /></span>
}

function ChatWorkspace({ session, authToken, onLogout, onSessionChange }) {
  const currentUserId = session.user.id
  const [chats, setChats] = useState([])
  const [activeId, setActiveId] = useState(1)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [statuses, setStatuses] = useState([])
  const [statusOpen, setStatusOpen] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [statusFile, setStatusFile] = useState(null)
  const [incomingCall, setIncomingCall] = useState(null)
  const [call, setCall] = useState(null)
  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [socketOnline, setSocketOnline] = useState(true)
  const [toast, setToast] = useState('')
  const [olderState, setOlderState] = useState({})
  const [homeMenuOpen, setHomeMenuOpen] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedChatIds, setSelectedChatIds] = useState(new Set())
  const [chatView, setChatView] = useState('all')
  const [starredOpen, setStarredOpen] = useState(false)
  const [unlockTokens, setUnlockTokens] = useState({})
  const [activePage, setActivePage] = useState('chats')
  const [callHistory, setCallHistory] = useState([])
  const [profileOpen, setProfileOpen] = useState(false)
  const [typingByChat, setTypingByChat] = useState({})
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [replyTo, setReplyTo] = useState(null)
  const [contactMenuOpen, setContactMenuOpen] = useState(false)
  const [messageSearchResults, setMessageSearchResults] = useState([])
  const [unreadMarkers, setUnreadMarkers] = useState({})
  const socketRef = useRef(null)
  const activeChatIdRef = useRef(activeId)
  const cameraVideoRef = useRef(null)
  const cameraStreamRef = useRef(null)
  const peerRef = useRef(null)
  const localStreamRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const localVideoRef = useRef(null)
  const callRef = useRef(null)
  const pendingCandidatesRef = useRef([])
  const typingTimerRef = useRef(null)
  const ringTimerRef = useRef(null)
  const toastTimerRef = useRef(null)
  const disconnectedAtRef = useRef(0)

  function flash(message) {
    setToast(message)
    clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(''), 4500)
  }

  const activeChat = chats.find((chat) => chat.id === activeId) || chats[0] || { id: null, name: 'Select a chat', avatar: '??', color: '#597d90', messages: [] }
  const filteredChats = useMemo(() => chats.filter((chat) => {
    const matchesView = chatView === 'archived' ? chat.archived : chatView === 'locked' ? chat.locked : !chat.archived && !chat.locked
    return matchesView && chat.name.toLowerCase().includes(query.toLowerCase())
  }), [chats, query, chatView])
  const starredMessages = useMemo(() => chats.flatMap((chat) => chat.messages.filter((message) => message.starred).map((message) => ({ ...message, chatName: chat.name }))), [chats])
  const archivedCount = chats.filter((chat) => chat.archived).length
  const lockedCount = chats.filter((chat) => chat.locked).length
  const archivedChats = chats.filter((chat) => chat.archived)

  function addStatus(status) {
    setStatuses((current) => current.some((item) => item.id === status.id) ? current : [status, ...current])
  }

  function appendReceivedMessage({ chatId, message }) {
    setChats((current) => current.map((chat) => {
      if (String(chat.id) !== String(chatId) || chat.messages.some((item) => item.id === message.id)) return chat
      const mine = message.senderId === currentUserId
      const preview = message.sticker ? 'Sticker' : message.image ? 'Photo' : message.text
      return { ...chat, lastMessage: `${mine ? 'You' : message.senderName}: ${preview}`, time: formatTime(message.createdAt), unread: String(chatId) === String(activeChatIdRef.current) ? 0 : (chat.unread || 0) + 1, messages: [...chat.messages, { ...message, mine, time: formatTime(message.createdAt) }] }
    }))
  }

  function stopLocalMedia() {
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    setLocalStream(null)
  }

  function cleanupCall() {
    clearTimeout(ringTimerRef.current)
    ringTimerRef.current = null
    peerRef.current?.close()
    peerRef.current = null
    pendingCandidatesRef.current = []
    stopLocalMedia()
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    setRemoteStream(null)
    setCall(null)
    setIncomingCall(null)
    callRef.current = null
  }

  function emitCallSignal(signal) {
    const details = callRef.current
    if (details?.targetSocketId) socketRef.current?.emit('call:signal', { targetSocketId: details.targetSocketId, callId: details.callId, signal })
  }

  function createPeerConnection(targetSocketId) {
    if (peerRef.current) return peerRef.current
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    peer.onicecandidate = (event) => event.candidate && emitCallSignal({ type: 'candidate', candidate: event.candidate })
    peer.ontrack = (event) => setRemoteStream(event.streams[0])
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') setCall((current) => current && { ...current, status: 'Connected' })
      if (['failed', 'closed'].includes(peer.connectionState)) cleanupCall()
    }
    localStreamRef.current?.getTracks().forEach((track) => peer.addTrack(track, localStreamRef.current))
    peerRef.current = peer
    callRef.current = { ...callRef.current, targetSocketId }
    return peer
  }

  async function startLocalMedia(type) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' })
    localStreamRef.current = stream
    setLocalStream(stream)
    return stream
  }

  async function refreshChats() {
    try {
      const response = await apiFetch(`/chats`, { credentials: 'include' })
      if (!response.ok) return
      const loaded = (await response.json()).map((chat) => normalizeChat(chat, currentUserId))
      setChats(loaded)
      // A reconnect returns locked chats without messages; restore the ones the
      // user already unlocked in this session.
      loaded.filter((chat) => chat.locked && unlockTokens[chat.id]).forEach((chat) => loadChatMessages(chat.id, unlockTokens[chat.id]))
    } catch { /* Keep whatever is on screen. */ }
  }

  async function requestUnlock(chatId) {
    const pin = window.prompt('Enter your locked-chat PIN:')?.trim() || ''
    if (!pin) return null
    if (!/^\d{4,6}$/.test(pin)) { window.alert('Enter your 4–6 digit PIN.'); return null }
    try {
      const response = await apiFetch(`/chats/${chatId}/unlock`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.token) { window.alert(data?.error || 'Incorrect PIN.'); return null }
      setUnlockTokens((current) => ({ ...current, [chatId]: data.token }))
      return data.token
    } catch {
      window.alert('This chat could not be unlocked. Try again.')
      return null
    }
  }

  async function loadChatMessages(chatId, token) {
    try {
      const response = await apiFetch(`/chats/${chatId}/messages`, { credentials: 'include', headers: token ? { 'x-chat-unlock': token } : {} })
      if (!response.ok) return false
      const loaded = (await response.json()).map((message) => normalizeMessage(message, currentUserId))
      setChats((current) => current.map((chat) => chat.id === chatId ? { ...chat, messages: loaded } : chat))
      return true
    } catch { return false }
  }

  async function loadOlderMessages() {
    const chat = activeChat
    if (!chat?.messages?.length || olderState[chat.id]?.loading || olderState[chat.id]?.done) return
    setOlderState((current) => ({ ...current, [chat.id]: { loading: true, done: false } }))
    try {
      const oldest = chat.messages[0].createdAt
      const token = unlockTokens[chat.id]
      const response = await apiFetch(`/chats/${chat.id}/messages?before=${encodeURIComponent(oldest)}`, { credentials: 'include', headers: token ? { 'x-chat-unlock': token } : {} })
      if (!response.ok) throw new Error('Older messages could not be loaded.')
      const older = await response.json()
      setChats((current) => current.map((item) => item.id === chat.id
        ? { ...item, messages: [...older.map((message) => normalizeMessage(message, currentUserId)), ...item.messages] }
        : item))
      setOlderState((current) => ({ ...current, [chat.id]: { loading: false, done: older.length < 100 } }))
    } catch (error) {
      setOlderState((current) => ({ ...current, [chat.id]: { loading: false, done: false } }))
      flash(error.message)
    }
  }

  async function handleCallSignal({ callId, fromSocketId, signal }) {
    if (!callRef.current || callRef.current.callId !== callId) return
    const peer = createPeerConnection(fromSocketId)
    try {
      if (signal.type === 'offer') {
        await peer.setRemoteDescription(signal.description)
        for (const candidate of pendingCandidatesRef.current) await peer.addIceCandidate(candidate)
        pendingCandidatesRef.current = []
        const answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        emitCallSignal({ type: 'answer', description: answer })
      } else if (signal.type === 'answer') {
        await peer.setRemoteDescription(signal.description)
        for (const candidate of pendingCandidatesRef.current) await peer.addIceCandidate(candidate)
        pendingCandidatesRef.current = []
      } else if (signal.type === 'candidate') {
        if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate)
        else pendingCandidatesRef.current.push(signal.candidate)
      }
    } catch (error) {
      console.error('Call signaling error:', error)
      cleanupCall()
    }
  }

  useEffect(() => {
    // Older builds kept the lock PIN in the browser; it now lives only on the server.
    localStorage.removeItem('chat-app-lock-pin')
    const controller = new AbortController()
    apiFetch(`/chats`, { signal: controller.signal, credentials: 'include' }).then((response) => response.ok ? response.json() : Promise.reject()).then((data) => { const loaded = data.map((chat) => normalizeChat(chat, currentUserId)); setChats(loaded); if (loaded[0]) setActiveId(loaded[0].id) }).catch(() => {})
    apiFetch(`/statuses`, { signal: controller.signal, credentials: 'include' }).then((response) => response.ok ? response.json() : Promise.reject()).then(setStatuses).catch(() => {})
    apiFetch(`/calls`, { signal: controller.signal, credentials: 'include' }).then((response) => response.ok ? response.json() : Promise.reject()).then((rows) => setCallHistory(rows.map((row) => ({ ...row, time: formatTime(row.time) })))).catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const socket = io(SERVER_URL, {
      withCredentials: true,
      auth: (callback) => callback({ token: authToken }),
    })
    socketRef.current = socket
    socket.on('message:new', appendReceivedMessage)
    socket.on('message:updated', ({ chatId, message }) => setChats((current) => current.map((chat) => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map((item) => item.id === message.id ? { ...message, starred: item.starred, mine: message.senderId === currentUserId, time: formatTime(message.createdAt) } : item) })))
    socket.on('message:starred', ({ chatId, messageId, userId, starred }) => {
      if (userId !== currentUserId) return
      setChats((current) => current.map((chat) => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map((item) => item.id === messageId ? { ...item, starred } : item) }))
    })
    socket.on('message:deleted', ({ chatId, messageId }) => setChats((current) => current.map((chat) => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map((item) => item.id === messageId ? { ...item, text: 'This message was deleted.', image: null, sticker: null, deletedAt: new Date().toISOString() } : item) })))
    socket.on('chat:new', (chat) => {
      const normalized = normalizeChat(chat, currentUserId)
      setChats((current) => current.some((item) => item.id === normalized.id) ? current : [normalized, ...current])
      socket.emit('chat:join', { chatId: normalized.id })
    })
    socket.on('chat:delivered', ({ chatId, userId }) => setChats((current) => current.map((chat) => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map((message) => message.mine && userId !== currentUserId ? { ...message, deliveredAt: message.deliveredAt || new Date().toISOString() } : message) })))
    socket.on('chat:read', ({ chatId, userId }) => setChats((current) => current.map((chat) => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map((message) => message.mine && userId !== currentUserId ? { ...message, readAt: new Date().toISOString() } : message) })))
    socket.on('presence:update', ({ userId, online, lastSeenAt }) => setChats((current) => current.map((chat) => chat.otherUserId === userId ? { ...chat, online, lastSeenAt: lastSeenAt || chat.lastSeenAt } : chat)))
    socket.on('user:updated', (update) => {
      setChats((current) => current.map((chat) => chat.otherUserId === update.userId
        ? { ...chat, name: update.displayName, avatar: update.avatar, color: update.color || chat.color, avatarUrl: update.avatarUrl }
        : chat))
      if (update.userId === currentUserId) {
        onSessionChange((current) => current ? { ...current, user: { ...current.user, displayName: update.displayName, avatar: update.avatar, avatarUrl: update.avatarUrl } } : current)
      }
    })
    socket.on('chat:typing', ({ chatId, userId, isTyping }) => setTypingByChat((current) => ({ ...current, [chatId]: isTyping ? userId : null })))
    socket.on('status:new', addStatus)
    socket.on('call:incoming', (details) => {
      if (callRef.current || details.callerSocketId === socket.id) return
      setIncomingCall(details)
      clearTimeout(ringTimerRef.current)
      ringTimerRef.current = setTimeout(() => {
        setIncomingCall((current) => {
          if (current?.callId !== details.callId) return current
          socket.emit('call:decline', { callId: details.callId })
          return null
        })
      }, 45_000)
      setCallHistory((current) => [{ id: details.callId, contact: details.callerName, type: details.type, direction: 'Incoming', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current])
    })
    socket.on('call:accepted', async ({ callId, receiverSocketId }) => {
      if (!callRef.current || callRef.current.callId !== callId) return
      try {
        const peer = createPeerConnection(receiverSocketId)
        const offer = await peer.createOffer()
        await peer.setLocalDescription(offer)
        emitCallSignal({ type: 'offer', description: offer })
      } catch (error) {
        console.error('Unable to open the media session:', error)
        cleanupCall()
        flash('The call could not be established.')
      }
    })
    socket.on('call:signal', handleCallSignal)
    socket.on('call:ended', ({ callId, reason }) => {
      setIncomingCall((current) => (current?.callId === callId ? null : current))
      clearTimeout(ringTimerRef.current)
      if (callRef.current?.callId !== callId) return
      cleanupCall()
      if (reason === 'no-answer') flash('No answer.')
      else if (reason === 'declined') flash('Call declined.')
      else if (reason === 'disconnected') flash('The call ended because the other person disconnected.')
      else if (reason === 'ended') flash('Call ended.')
    })
    socket.on('disconnect', () => {
      setSocketOnline(false)
      disconnectedAtRef.current = Date.now()
      if (callRef.current) cleanupCall()
      setIncomingCall(null)
    })
    socket.on('connect_error', () => setSocketOnline(false))
    socket.on('connect', () => {
      setSocketOnline(true)
      if (callRef.current) { cleanupCall(); flash('The call ended while reconnecting.') }
      setIncomingCall(null)
      if (disconnectedAtRef.current) {
        if (Date.now() - disconnectedAtRef.current > 3000) flash('Connected again.')
        refreshChats()
      }
      disconnectedAtRef.current = 0
    })
    return () => { cleanupCall(); socket.disconnect(); socketRef.current = null }
  }, [])

  useEffect(() => { activeChatIdRef.current = activeId }, [activeId])
  useEffect(() => {
    if (query.trim().length < 2) { setMessageSearchResults([]); return }
    const controller = new AbortController()
    const timer = setTimeout(() => apiFetch(`/search?query=${encodeURIComponent(query)}`, { credentials: 'include', signal: controller.signal }).then((response) => response.ok ? response.json() : null).then((data) => setMessageSearchResults(data?.messages || []) ).catch(() => {}), 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query])
  useEffect(() => { chats.forEach((chat) => socketRef.current?.emit('chat:join', { chatId: chat.id, unlockToken: unlockTokens[chat.id] })) }, [chats, unlockTokens])
  useEffect(() => {
    if (!homeMenuOpen && !contactMenuOpen) return
    function closeMenus(event) {
      if (event.type === 'keydown' && event.key !== 'Escape') return
      if (event.type === 'pointerdown' && event.target.closest?.('.menu-anchor')) return
      setHomeMenuOpen(false)
      setContactMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeMenus)
    document.addEventListener('keydown', closeMenus)
    return () => {
      document.removeEventListener('pointerdown', closeMenus)
      document.removeEventListener('keydown', closeMenus)
    }
  }, [homeMenuOpen, contactMenuOpen])
  useEffect(() => { if (cameraOpen && cameraVideoRef.current && cameraStreamRef.current) cameraVideoRef.current.srcObject = cameraStreamRef.current }, [cameraOpen])
  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream
  }, [call, localStream, remoteStream])

  async function updateChat(chatId, updates) {
    setChats((current) => current.map((chat) => chat.id === chatId ? { ...chat, ...updates } : chat))
    try {
      const response = await apiFetch(`/chats/${chatId}/preferences`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || 'That change could not be saved.')
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }

  function toggleSelectedChat(id) {
    setSelectedChatIds((current) => {
      const next = new Set(current)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function leaveSelectionMode() {
    setSelectionMode(false)
    setSelectedChatIds(new Set())
  }

  async function applyToSelected(updates) {
    const ids = [...selectedChatIds]
    await Promise.all(ids.map((id) => updateChat(id, updates)))
    leaveSelectionMode()
  }

  async function markSelectedRead() {
    await Promise.all([...selectedChatIds].map((id) => apiFetch(`/chats/${id}/read`, { method: 'POST', credentials: 'include', headers: unlockTokens[id] ? { 'x-chat-unlock': unlockTokens[id] } : {} }).catch(() => {})))
    setChats((current) => current.map((chat) => selectedChatIds.has(chat.id) ? { ...chat, unread: 0 } : chat))
    leaveSelectionMode()
  }

  async function archiveSelected() {
    await applyToSelected({ archived: chatView !== 'archived' })
    setChatView(chatView === 'archived' ? 'all' : chatView)
  }

  async function lockSelected() {
    const selected = chats.filter((chat) => selectedChatIds.has(chat.id))
    if (!selected.length) return
    const locking = selected.some((chat) => !chat.locked)
    const targets = selected.filter((chat) => locking ? !chat.locked : chat.locked)
    if (!targets.length) { leaveSelectionMode(); return }
    const pin = window.prompt(locking ? 'Set a 4–6 digit PIN for locked chats:' : 'Enter your locked-chat PIN:')?.trim() || ''
    if (!/^\d{4,6}$/.test(pin)) return window.alert(locking ? 'Choose a 4–6 digit PIN to lock chats.' : 'Enter your 4–6 digit PIN.')
    const results = await Promise.all(targets.map((chat) => updateChat(chat.id, { locked: locking, pin })))
    const failure = results.find((result) => !result.ok)
    if (failure) { flash(failure.error); refreshChats(); return }
    if (locking) {
      const lockedIds = new Set(targets.map((chat) => chat.id))
      setChats((current) => current.map((chat) => lockedIds.has(chat.id) ? { ...chat, messages: [], lastMessage: 'Locked chat' } : chat))
      setUnlockTokens((current) => { const next = { ...current }; lockedIds.forEach((id) => delete next[id]); return next })
    } else {
      setUnlockTokens((current) => { const next = { ...current }; targets.forEach((chat) => delete next[chat.id]); return next })
      await Promise.all(targets.map((chat) => loadChatMessages(chat.id, null)))
    }
    leaveSelectionMode()
    setChatView('all')
  }

  async function markAllRead() {
    setChats((current) => current.map((chat) => ({ ...chat, unread: 0 })))
    setHomeMenuOpen(false)
    try { await Promise.all(chats.map((chat) => apiFetch(`/chats/${chat.id}/read`, { method: 'POST', credentials: 'include', headers: unlockTokens[chat.id] ? { 'x-chat-unlock': unlockTokens[chat.id] } : {} }))) } catch { /* Local preview already updated. */ }
  }

  function openNewChat() {
    setNewChatOpen(true)
    setHomeMenuOpen(false)
  }

  function openLockedChats() {
    if (!lockedCount) return window.alert('No chats are locked yet.')
    setChatView('locked'); setActivePage('chats'); setHomeMenuOpen(false)
  }

  async function toggleStar(chatId, messageId, starred) {
    const nextStarred = !starred
    setChats((current) => current.map((chat) => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map((message) => message.id === messageId ? { ...message, starred: nextStarred } : message) }))
    try {
      const response = await apiFetch(`/messages/${messageId}/star`, { method: nextStarred ? 'POST' : 'DELETE', credentials: 'include' })
      if (!response.ok) throw new Error()
    } catch {
      setChats((current) => current.map((chat) => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map((message) => message.id === messageId ? { ...message, starred } : message) }))
      window.alert('This message could not be starred. Try again.')
    }
  }

  async function unlockActiveChat() {
    const token = await requestUnlock(activeId)
    if (!token) return
    await loadChatMessages(activeId, token)
    socketRef.current?.emit('chat:join', { chatId: activeId, unlockToken: token })
  }

  async function selectChat(id) {
    if (selectionMode) return toggleSelectedChat(id)
    const target = chats.find((chat) => chat.id === id)
    let unlockToken = unlockTokens[id]
    if (target?.locked) {
      const token = unlockToken || await requestUnlock(id)
      if (!token) return
      unlockToken = token
      if (!target.messages.length) await loadChatMessages(id, token)
      socketRef.current?.emit('chat:join', { chatId: id, unlockToken: token })
    }
    if (target?.unread > 0) {
      const incoming = target.messages.filter((message) => !message.mine)
      const firstUnread = incoming[Math.max(0, incoming.length - target.unread)]
      if (firstUnread) setUnreadMarkers((current) => ({ ...current, [id]: firstUnread.id }))
    }
    setActiveId(id); setMobileOpen(true); setPickerOpen(false)
    setContactMenuOpen(false)
    setChats((current) => current.map((chat) => chat.id === id ? { ...chat, unread: 0 } : chat))
    apiFetch(`/chats/${id}/read`, { method: 'POST', credentials: 'include', headers: unlockToken ? { 'x-chat-unlock': unlockToken } : {} }).catch(() => {})
  }

  async function sendContent({ text = '', image = '', sticker = '' }) {
    if (!activeId) return
    const token = unlockTokens[activeId]
    const payload = { chatId: activeId, text, image, sticker, replyToId: replyTo?.id, unlockToken: token }
    if (socketRef.current?.connected) {
      socketRef.current.emit('message:send', payload, (result) => {
        if (result?.ok) return
        flash(result?.error || 'Message could not be sent.')
        // An expired unlock token is cleared so the next attempt asks for the PIN again.
        if (String(result?.error || '').toLowerCase().includes('locked')) {
          setUnlockTokens((current) => { const next = { ...current }; delete next[activeId]; return next })
        }
      })
      return
    }
    try {
      const response = await apiFetch(`/chats/${activeId}/messages`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'x-chat-unlock': token } : {}) },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Message could not be sent.')
      appendReceivedMessage(await response.json())
    } catch (error) {
      flash(error.message)
    }
  }

  async function sendMessage(event) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft(''); setPickerOpen(false); setReplyTo(null)
    await sendContent({ text })
  }

  async function editMessage(message) {
    const text = window.prompt('Edit message:', message.text)
    if (!text?.trim()) return
    const response = await apiFetch(`/messages/${message.id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(unlockTokens[message.chatId] ? { 'x-chat-unlock': unlockTokens[message.chatId] } : {}) }, body: JSON.stringify({ text }) })
    if (!response.ok) return window.alert('This message could not be edited.')
    const updated = await response.json()
    setChats((current) => current.map((chat) => chat.id === activeId ? { ...chat, messages: chat.messages.map((item) => item.id === updated.id ? { ...updated, time: formatTime(updated.createdAt) } : item) } : chat))
  }

  async function deleteMessage(message) {
    if (!window.confirm('Delete this message?')) return
    const response = await apiFetch(`/messages/${message.id}`, { method: 'DELETE', credentials: 'include', headers: unlockTokens[message.chatId] ? { 'x-chat-unlock': unlockTokens[message.chatId] } : {} })
    if (!response.ok) return window.alert('This message could not be deleted.')
    setChats((current) => current.map((chat) => chat.id === activeId ? { ...chat, messages: chat.messages.map((item) => item.id === message.id ? { ...item, text: 'This message was deleted.', deletedAt: new Date().toISOString(), image: null, sticker: null } : item) } : chat))
  }

  async function forwardMessage(message) {
    const destination = window.prompt(`Forward to which chat? Enter a contact name:\n${chats.filter((chat) => chat.id !== activeId).map((chat) => chat.name).join('\n')}`)?.toLowerCase()
    const target = chats.find((chat) => chat.id !== activeId && chat.name.toLowerCase() === destination)
    if (!target) return
    const response = await apiFetch(`/messages/${message.id}/forward`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(unlockTokens[message.chatId] ? { 'x-chat-unlock': unlockTokens[message.chatId] } : {}) }, body: JSON.stringify({ targetChatId: target.id, unlockToken: unlockTokens[target.id] }) })
    if (!response.ok) window.alert('This message could not be forwarded.')
  }

  async function reactToMessage(message, emoji) {
    const response = await apiFetch(`/messages/${message.id}/reactions`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(unlockTokens[message.chatId] ? { 'x-chat-unlock': unlockTokens[message.chatId] } : {}) }, body: JSON.stringify({ emoji }) })
    if (!response.ok) return
    const updated = await response.json()
    setChats((current) => current.map((chat) => chat.id === activeId ? { ...chat, messages: chat.messages.map((item) => item.id === updated.id ? { ...updated, time: formatTime(updated.createdAt) } : item) } : chat))
  }

  async function blockActiveUser() {
    if (!activeChat.otherUserId || !window.confirm(`Block ${activeChat.name}?`)) return
    const response = await apiFetch(`/users/${activeChat.otherUserId}/block`, { method: 'POST', credentials: 'include' })
    if (response.ok) { setChats((current) => current.filter((chat) => chat.id !== activeId)); setContactMenuOpen(false) }
  }

  async function reportActiveUser() {
    if (!activeChat.otherUserId) return
    const reason = window.prompt('Why are you reporting this user?')?.trim()
    if (!reason) return
    const response = await apiFetch(`/users/${activeChat.otherUserId}/report`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) })
    if (response.ok) { window.alert('Report submitted.'); setContactMenuOpen(false) }
  }

  function updateDraft(event) {
    const value = event.target.value
    setDraft(value)
    if (!socketRef.current?.connected) return
    socketRef.current.emit('chat:typing', { chatId: activeId, isTyping: Boolean(value), unlockToken: unlockTokens[activeId] })
    clearTimeout(typingTimerRef.current)
    typingTimerRef.current = setTimeout(() => socketRef.current?.emit('chat:typing', { chatId: activeId, isTyping: false, unlockToken: unlockTokens[activeId] }), 1200)
  }

  async function openCamera() {
    try {
      cameraStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      setCameraOpen(true)
    } catch {
      window.alert('Camera access was not available. Please allow it in your browser settings.')
    }
  }

  function closeCamera() {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
    cameraStreamRef.current = null; setCameraOpen(false)
  }

  function capturePhoto() {
    const video = cameraVideoRef.current
    if (!video?.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    closeCamera()
    canvas.toBlob(async (blob) => {
      if (!blob) return
      try {
        const form = new FormData()
        form.append('file', blob, 'photo.jpg')
        const response = await apiFetch(`/chats/${activeId}/attachments`, { method: 'POST', credentials: 'include', headers: unlockTokens[activeId] ? { 'x-chat-unlock': unlockTokens[activeId] } : {}, body: form })
        const data = await response.json().catch(() => null)
        if (!response.ok) throw new Error(data?.error || 'The photo could not be uploaded.')
        sendContent({ image: data.path })
      } catch (error) { flash(error.message) }
    }, 'image/jpeg', 0.8)
  }

  async function publishStatus(event) {
    event.preventDefault()
    if (!statusText.trim() && !statusFile) return
    const body = new FormData()
    body.append('text', statusText.trim())
    if (statusFile) body.append('media', statusFile)
    try {
      const response = await apiFetch(`/statuses`, { method: 'POST', body })
      if (!response.ok) throw new Error()
      addStatus(await response.json())
      setStatusText(''); setStatusFile(null)
    } catch { window.alert('Your status could not be uploaded. Is the backend running?') }
  }

  async function startCall(type, chatOverride) {
    const targetChat = chatOverride || activeChat
    if (!targetChat?.id) return flash('Choose a chat first.')
    if (targetChat.group) return flash('Calls are only available in one-to-one chats.')
    if (!socketRef.current?.connected) return flash('You are offline. Wait for the connection to return.')
    if (callRef.current) return flash('You are already in a call.')
    try {
      await startLocalMedia(type)
      const callId = createId()
      callRef.current = { callId, type, role: 'caller', targetSocketId: null, chatId: targetChat.id }
      setCall({ type, status: 'Calling…', contact: targetChat.name })
      setCallHistory((current) => [{ id: callId, contact: targetChat.name, type, direction: 'Outgoing', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current])
      socketRef.current.timeout(8000).emit('call:request', { chatId: targetChat.id, callId, type, unlockToken: unlockTokens[targetChat.id] }, (error, result) => {
        if (!error && result?.ok) return
        if (callRef.current?.callId !== callId) return
        socketRef.current?.emit('call:end', { callId })
        cleanupCall()
        flash(error ? `${targetChat.name} could not be reached.` : (result?.error || 'The call could not be started.'))
      })
    } catch { flash('Microphone or camera access is required for calls.') }
  }

  async function acceptCall() {
    if (!incomingCall) return
    const incoming = incomingCall
    try {
      await startLocalMedia(incoming.type)
      callRef.current = { callId: incoming.callId, type: incoming.type, role: 'receiver', targetSocketId: incoming.callerSocketId, chatId: incoming.chatId }
      setCall({ type: incoming.type, status: 'Connecting…', contact: incoming.callerName })
      setIncomingCall(null)
      clearTimeout(ringTimerRef.current)
      socketRef.current?.timeout(8000).emit('call:accept', { callId: incoming.callId }, (error, result) => {
        if (!error && result?.ok) return
        if (callRef.current?.callId !== incoming.callId) return
        cleanupCall()
        flash(error ? 'The call could not be answered.' : (result?.error || 'This call is no longer available.'))
      })
    } catch { flash('Microphone or camera access is required for calls.') }
  }

  function endCall() {
    const callId = callRef.current?.callId || incomingCall?.callId
    if (callId) {
      if (callRef.current) socketRef.current?.emit('call:end', { callId })
      else socketRef.current?.emit('call:decline', { callId })
    }
    cleanupCall()
  }

  return <main className={`app-shell ${mobileOpen ? 'mobile-chat-open' : ''}`}>
    {!socketOnline && <div className="connection-banner" role="status">Reconnecting… messages and calls will resume automatically.</div>}
    {toast && <div className="app-toast" role="status">{toast}</div>}
    <aside className="sidebar" aria-label="Chats">
      <header className="sidebar-header"><button className="profile-avatar profile-button" style={session.user.avatarUrl ? { backgroundImage: `url(${SERVER_URL}${session.user.avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined} onClick={() => setProfileOpen(true)} aria-label="Open profile">{session.user.avatarUrl ? '' : session.user.avatar}</button><div className="header-actions"><button className="icon-button" onClick={openNewChat} aria-label="New chat">✎</button><span className="menu-anchor"><button className="icon-button" onClick={() => setHomeMenuOpen((open) => !open)} aria-label="More options">⋮</button>{homeMenuOpen && <div className="home-menu"><button onClick={() => { setNewGroupOpen(true); setHomeMenuOpen(false) }}>New Group</button><button onClick={() => { setSelectionMode(true); setActivePage('chats'); setHomeMenuOpen(false) }}>Select chats</button><button onClick={markAllRead}>Mark all as read</button><button onClick={openLockedChats}>Locked chats{lockedCount ? ` (${lockedCount})` : ''}</button><button onClick={() => { setStarredOpen(true); setHomeMenuOpen(false) }}>Starred messages</button><button onClick={() => { setActivePage('archive'); setHomeMenuOpen(false) }}>Archived{archivedCount ? ` (${archivedCount})` : ''}</button><button onClick={onLogout}>Log out</button></div>}</span></div></header>
      <div className="chat-list-title">{selectionMode ? <><h1>{selectedChatIds.size} selected</h1><button className="text-button" onClick={leaveSelectionMode}>Cancel</button></> : <><h1>{chatView === 'archived' ? 'Archived' : chatView === 'locked' ? 'Locked chats' : 'Chats'}</h1><button className="new-chat-button" onClick={openNewChat} aria-label="Start a new chat">＋</button></>}</div>
      <button className="status-strip" onClick={() => setActivePage('status')}><span className="status-ring"><span className="profile-avatar small-profile">DS</span></span><span><strong>My status</strong><small>{statuses.length ? 'Tap to add an update' : 'No updates yet'}</small></span><b>＋</b></button>
      {!selectionMode && chatView === 'all' && <button className="section-shortcut" onClick={() => setActivePage('archive')}><span>▱ Archived</span><b>{archivedCount || ''}</b></button>}
      {chatView !== 'all' && !selectionMode && <button className="section-shortcut" onClick={() => setChatView('all')}>‹ Back to chats</button>}
      <label className="search-box"><span aria-hidden="true">⌕</span><input type="search" placeholder="Search or start a new chat" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <nav className="chat-list">{filteredChats.map((chat) => <button className={`chat-row ${chat.id === activeId ? 'selected' : ''} ${selectedChatIds.has(chat.id) ? 'multi-selected' : ''}`} key={chat.id} onClick={() => selectChat(chat.id)}>{selectionMode && <span className="selection-check">{selectedChatIds.has(chat.id) ? '✓' : ''}</span>}<Avatar chat={chat} /><span className="chat-preview"><span className="chat-topline"><strong>{chat.name}</strong><time>{chat.time}</time></span><span className="chat-bottomline"><span>{chat.lastMessage}</span>{chat.unread > 0 && <b className="unread-count">{chat.unread}</b>}</span></span></button>)}{query.length >= 2 && messageSearchResults.length > 0 && <><p className="search-result-label">Message results</p>{messageSearchResults.map((message) => <button className="message-search-result" key={message.id} onClick={() => { setActiveId(message.chatId); setMobileOpen(true) }}><strong>{message.senderName}</strong><span>{message.text}</span></button>)}</>}{!filteredChats.length && !messageSearchResults.length && <p className="empty-search">No chats or messages found.</p>}</nav>
      {selectionMode && <div className="selection-actions"><button disabled={!selectedChatIds.size} onClick={archiveSelected}>{chatView === 'archived' ? 'Unarchive' : 'Archive'}</button><button disabled={!selectedChatIds.size} onClick={lockSelected}>Lock / unlock</button><button disabled={!selectedChatIds.size} onClick={markSelectedRead}>Mark read</button></div>}
      <nav className="category-nav" aria-label="Main navigation"><button className={activePage === 'chats' ? 'active' : ''} onClick={() => { setActivePage('chats'); setChatView('all') }}><span>☷</span>Chats</button><button className={activePage === 'status' ? 'active' : ''} onClick={() => setActivePage('status')}><span>◌</span>Status</button><button className={activePage === 'calls' ? 'active' : ''} onClick={() => setActivePage('calls')}><span>☎</span>Calls</button><button className={activePage === 'archive' ? 'active' : ''} onClick={() => setActivePage('archive')}><span>▱</span>Archive</button></nav>
    </aside>
    {activePage === 'chats' ? <section className="conversation" aria-label={`Chat with ${activeChat.name}`}>
      <header className="conversation-header"><button className="back-button" onClick={() => setMobileOpen(false)} aria-label="Back to chats">‹</button><Avatar chat={activeChat} large /><div className="contact-details"><strong>{activeChat.name}</strong><span>{typingByChat[activeId] ? 'typing…' : activeChat.group ? `${activeChat.memberCount || 1} members` : activeChat.online ? 'online' : lastSeenLabel(activeChat.lastSeenAt)}</span></div><div className="header-actions conversation-actions">{!activeChat.group && <><button className="icon-button" onClick={() => startCall('video')} aria-label="Video call">📹</button><button className="icon-button" onClick={() => startCall('audio')} aria-label="Audio call">📞</button></>}{!activeChat.group && <span className="menu-anchor"><button className="icon-button" onClick={() => setContactMenuOpen((open) => !open)} aria-label="Chat options">⋮</button>{contactMenuOpen && <div className="home-menu contact-menu"><button onClick={blockActiveUser}>Block user</button><button onClick={reportActiveUser}>Report user</button></div>}</span>}</div></header>
      {activeChat.locked && !unlockTokens[activeChat.id] ? <div className="locked-chat-panel"><span className="lock-badge" aria-hidden="true">🔒</span><h2>This chat is locked</h2><p>Enter your PIN to view this conversation.</p><button className="unlock-button" onClick={unlockActiveChat}>Unlock chat</button></div> : <div className="message-area">{activeChat.messages.length >= 100 && !olderState[activeChat.id]?.done && <button className="load-older" onClick={loadOlderMessages} disabled={olderState[activeChat.id]?.loading}>{olderState[activeChat.id]?.loading ? 'Loading earlier messages…' : 'Load earlier messages'}</button>}<span className="encryption-notice">🔒 Live messages and calls are enabled.</span><span className="date-chip">TODAY</span>{activeChat.messages.map((message) => <Fragment key={message.id}>{unreadMarkers[activeChat.id] === message.id && <span className="unread-separator">UNREAD</span>}<article className={`message ${message.mine ? 'outgoing' : 'incoming'}`}>{message.replyTo && <div className="reply-preview">↩ {message.replyTo.text || 'Message'}</div>}{message.sender && <strong className="message-sender">{message.sender}</strong>}{message.senderName && !message.mine && activeChat.group && <strong className="message-sender">{message.senderName}</strong>}{message.image && <img className="chat-image" src={mediaSrc(message.image)} alt="Shared from camera" />}{message.sticker && <span className="sticker-message">{message.sticker}</span>}{message.text && <span>{message.text}</span>}{message.reactions?.length > 0 && <span className="reaction-summary">{message.reactions.map((reaction) => reaction.emoji).join(' ')}</span>}<div className="message-actions"><button onClick={() => navigator.clipboard?.writeText(message.text)}>Copy</button><button onClick={() => setReplyTo(message)}>Reply</button><button onClick={() => forwardMessage(message)}>Forward</button><button onClick={() => reactToMessage(message, '👍')}>👍</button>{message.mine && <><button onClick={() => editMessage(message)}>Edit</button><button onClick={() => deleteMessage(message)}>Delete</button></>}</div><button className={`star-message ${message.starred ? 'starred' : ''}`} onClick={() => toggleStar(activeChat.id, message.id, message.starred)} aria-label={message.starred ? 'Remove star' : 'Star message'}>{message.starred ? '★' : '☆'}</button><time>{message.time}{message.editedAt && ' · edited'}{message.mine && <em>{message.readAt ? ' ✓✓' : message.deliveredAt ? ' ✓✓' : ' ✓'}</em>}</time></article></Fragment>)}</div>}
      {!(activeChat.locked && !unlockTokens[activeChat.id]) && <>{pickerOpen && <div className="picker-panel"><div><small>EMOJI</small>{emojiChoices.map((emoji) => <button key={emoji} onClick={() => setDraft((value) => `${value}${emoji}`)}>{emoji}</button>)}</div><div><small>STICKERS</small>{stickerChoices.map((sticker) => <button className="sticker-choice" key={sticker} onClick={() => { sendContent({ sticker }); setPickerOpen(false) }}>{sticker}</button>)}</div></div>}
      {replyTo && <div className="replying-banner">Replying to: {replyTo.text || 'media'}<button onClick={() => setReplyTo(null)}>×</button></div>}<form className="message-composer" onSubmit={sendMessage}><button type="button" className="composer-button" onClick={() => setPickerOpen((open) => !open)} aria-label="Emoji and stickers">☺</button><button type="button" className="composer-button" onClick={openCamera} aria-label="Take a photo">📷</button><input aria-label="Type a message" value={draft} onChange={updateDraft} placeholder="Type a message" /><button type="submit" className="send-button" aria-label="Send message">➤</button></form></>}
    </section> : <section className="feature-page">
      {activePage === 'status' && <><header className="feature-header"><div><h1>Status</h1><p>Updates disappear after 24 hours.</p></div></header><div className="feature-content"><form className="status-page-form" onSubmit={publishStatus}><textarea value={statusText} onChange={(event) => setStatusText(event.target.value)} placeholder="Share an update…" maxLength="500" /><label className="upload-status">Add photo or video<input type="file" accept="image/*,video/*" onChange={(event) => setStatusFile(event.target.files?.[0] || null)} /></label>{statusFile && <small className="selected-file">Selected: {statusFile.name}</small>}<button className="publish-status" type="submit">Post status</button></form><h2 className="feature-subtitle">Recent updates</h2><div className="status-list">{statuses.map((status) => <article className="status-item" key={status.id}><Avatar chat={status} /> <div><strong>{status.author}</strong><small>{new Date(status.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>{status.text && <p>{status.text}</p>}{status.mediaUrl && (status.mediaType?.startsWith('video') ? <video controls src={`${SERVER_URL}${status.mediaUrl}`} /> : <img src={`${SERVER_URL}${status.mediaUrl}`} alt={`${status.author}'s status`} />)}</div></article>)}{!statuses.length && <p className="empty-search">No recent status updates.</p>}</div></div></>}
      {activePage === 'calls' && <><header className="feature-header"><div><h1>Calls</h1><p>Start an audio or video call with a chat.</p></div></header><div className="feature-content"><h2 className="feature-subtitle">Start a call</h2>{chats.filter((chat) => !chat.archived && !chat.locked && !chat.group).map((chat) => <article className="call-row" key={chat.id}><Avatar chat={chat} /><strong>{chat.name}</strong><span /><button onClick={() => startCall('audio', chat)} aria-label={`Audio call ${chat.name}`}>📞</button><button onClick={() => startCall('video', chat)} aria-label={`Video call ${chat.name}`}>📹</button></article>)}<h2 className="feature-subtitle">Recent calls</h2>{callHistory.map((entry) => <article className="call-history" key={entry.id}><span>{entry.type === 'video' ? '📹' : '📞'}</span><div><strong>{entry.contact}</strong><small>{entry.direction} · {entry.time}</small></div></article>)}{!callHistory.length && <p className="empty-search">No calls yet.</p>}</div></>}
      {activePage === 'archive' && <><header className="feature-header"><div><h1>Archived chats</h1><p>Archived chats stay here until you restore them.</p></div></header><div className="feature-content">{archivedChats.map((chat) => <article className="archive-row" key={chat.id}><Avatar chat={chat} /><div><strong>{chat.name}</strong><small>{chat.lastMessage}</small></div><button onClick={() => updateChat(chat.id, { archived: false })}>Unarchive</button></article>)}{!archivedChats.length && <p className="empty-search">No archived chats.</p>}</div></>}
    </section>}
    {cameraOpen && <div className="modal-backdrop"><section className="camera-modal"><video ref={cameraVideoRef} autoPlay playsInline /><div><button onClick={closeCamera}>Cancel</button><button className="capture-button" onClick={capturePhoto} aria-label="Take photo">●</button></div></section></div>}
    {statusOpen && <div className="modal-backdrop"><section className="status-modal"><header><h2>Status</h2><button onClick={() => setStatusOpen(false)}>×</button></header><form onSubmit={publishStatus}><textarea value={statusText} onChange={(event) => setStatusText(event.target.value)} placeholder="Share an update…" maxLength="500" /><label className="upload-status">Add photo or video<input type="file" accept="image/*,video/*" onChange={(event) => setStatusFile(event.target.files?.[0] || null)} /></label>{statusFile && <small className="selected-file">Selected: {statusFile.name}</small>}<button className="publish-status" type="submit">Post status</button></form><h3>Recent updates</h3><div className="status-list">{statuses.map((status) => <article className="status-item" key={status.id}><Avatar chat={status} /> <div><strong>{status.author}</strong><small>{new Date(status.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>{status.text && <p>{status.text}</p>}{status.mediaUrl && (status.mediaType?.startsWith('video') ? <video controls src={`${SERVER_URL}${status.mediaUrl}`} /> : <img src={`${SERVER_URL}${status.mediaUrl}`} alt={`${status.author}'s status`} />)}</div></article>)}{!statuses.length && <p>No recent status updates.</p>}</div></section></div>}
    {starredOpen && <div className="modal-backdrop"><section className="status-modal"><header><h2>Starred messages</h2><button onClick={() => setStarredOpen(false)}>×</button></header><div className="starred-list">{starredMessages.map((message) => <article className="starred-item" key={`${message.chatName}-${message.id}`}><small>{message.chatName} · {message.time}</small>{message.image && <img src={mediaSrc(message.image)} alt="Starred shared media" />}{message.sticker && <span className="sticker-message">{message.sticker}</span>}<p>{message.text}</p></article>)}{!starredMessages.length && <p className="empty-search">Star a message in any chat to find it here.</p>}</div></section></div>}
    {profileOpen && <ProfilePanel session={session} onClose={() => setProfileOpen(false)} onSessionChange={onSessionChange} onAccountDeleted={onLogout} />}
    {newChatOpen && <NewChatPanel inviterName={session.user.displayName} onClose={() => setNewChatOpen(false)} onCreated={(chat) => { const normalized = normalizeChat(chat, currentUserId); setChats((current) => [normalized, ...current.filter((item) => item.id !== normalized.id)]); setActiveId(normalized.id); socketRef.current?.emit('chat:join', { chatId: normalized.id }); setMobileOpen(true); setNewChatOpen(false) }} />}
    {newGroupOpen && <NewGroupPanel chats={chats} currentUserId={currentUserId} onClose={() => setNewGroupOpen(false)} onCreated={(chat) => { const normalized = normalizeChat(chat, currentUserId); setChats((current) => [normalized, ...current.filter((item) => item.id !== normalized.id)]); setActiveId(normalized.id); setActivePage('chats'); setChatView('all'); socketRef.current?.emit('chat:join', { chatId: normalized.id }); setMobileOpen(true); setNewGroupOpen(false) }} />}
    {incomingCall && !call && <div className="modal-backdrop"><section className="incoming-call"><span className="call-avatar">☎</span><h2>{incomingCall.callerName}</h2><p>Incoming {incomingCall.type} call…</p><div><button className="decline-call" onClick={endCall}>Decline</button><button className="accept-call" onClick={acceptCall}>Accept</button></div></section></div>}
    {call && <div className="call-screen"><video className="remote-video" ref={remoteVideoRef} autoPlay playsInline /><video className="local-video" ref={localVideoRef} autoPlay muted playsInline /><div className="call-info"><strong>{call.contact}</strong><span>{call.status}</span></div><button className="end-call" onClick={endCall}>End call</button></div>}
  </main>
}

function AuthScreen({ onAuthenticated }) {
  const params = new URLSearchParams(window.location.search)
  const resetToken = params.get('reset')
  const invitePhone = params.get('phone')
  const invite = invitePhone ? splitPhone(invitePhone) : null
  const [mode, setMode] = useState(resetToken ? 'reset' : invite ? 'register' : 'login')
  const [loginWith, setLoginWith] = useState('phone')
  const [country, setCountry] = useState(invite?.country || DEFAULT_COUNTRY)
  const [phone, setPhone] = useState(invite?.national || '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(null)
  const [resendIn, setResendIn] = useState(0)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (resendIn <= 0) return
    const timer = setTimeout(() => setResendIn((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendIn])

  async function post(path, body, { retry = false } = {}) {
    const options = { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    const response = retry
      ? await apiFetchWithWakeRetry(path, options, () => setNotice('The chat server is waking up. Retrying…'))
      : await apiFetch(path, options)
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Unable to continue.')
    return data
  }

  async function submit(event) {
    event.preventDefault()
    setError(''); setNotice(''); setBusy(true)
    try {
      if (mode === 'login') {
        onAuthenticated(await post('/auth/login', loginWith === 'phone' ? { identifier: phone, country, password } : { identifier: email, password }, { retry: true }))
      } else if (mode === 'register') {
        const data = await post('/auth/register/start', { country, phone, displayName, email, password })
        setPending(data); setCode(''); setResendIn(60); setMode('verify')
      } else if (mode === 'verify') {
        onAuthenticated(await post('/auth/register/verify', { pendingId: pending.pendingId, code }))
      } else if (mode === 'forgot') {
        const data = await post('/auth/forgot-password', { email })
        setNotice(data.message || 'If an account exists for that email, a reset link has been sent.')
      } else {
        onAuthenticated(await post('/auth/reset-password', { token: resetToken, password }))
      }
    } catch (requestError) {
      setError(requestError instanceof TypeError ? `The chat server at ${SERVER_URL} did not answer. It may be starting up — wait about 30 seconds and try again.` : requestError.message)
    } finally { setBusy(false) }
  }

  async function resendCode() {
    if (!pending || resendIn > 0) return
    setError(''); setNotice('')
    try {
      const data = await post('/auth/register/resend', { pendingId: pending.pendingId })
      setNotice(data.message || 'A new code is on its way.')
      setResendIn(60)
    } catch (requestError) { setError(requestError.message) }
  }

  const heading = mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Create your account' : mode === 'verify' ? 'Verify your email' : mode === 'forgot' ? 'Recover your account' : 'Choose a new password'
  const submitLabel = busy ? 'Please wait…' : mode === 'login' ? 'Log in' : mode === 'register' ? 'Send verification code' : mode === 'verify' ? 'Verify and continue' : mode === 'forgot' ? 'Send recovery email' : 'Reset password'

  return <main className="auth-page"><section className="auth-card">
    <div className="auth-brand"><span>◌</span><h1>Chat App</h1><p>Private, real-time conversations.</p></div>
    <h2>{heading}</h2>
    <form onSubmit={submit}>
      {mode === 'login' && <div className="auth-toggle">
        <button type="button" className={loginWith === 'phone' ? 'active' : ''} onClick={() => { setLoginWith('phone'); setError('') }}>Phone</button>
        <button type="button" className={loginWith === 'email' ? 'active' : ''} onClick={() => { setLoginWith('email'); setError('') }}>Email</button>
      </div>}
      {mode === 'register' && <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength="80" required /></label>}
      {mode === 'login' && loginWith === 'phone' && <label>Phone number<span className="phone-row"><CountryPicker value={country} onChange={setCountry} /><input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" placeholder="98765 43210" required /></span></label>}
      {mode === 'register' && <label>Phone number<span className="phone-row"><CountryPicker value={country} onChange={setCountry} /><input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" placeholder="98765 43210" required /></span><small className="field-hint">{dialCodeFor(country)} · your number is your login</small></label>}
      {((mode === 'login' && loginWith === 'email') || mode === 'register' || mode === 'forgot') && <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>}
      {mode === 'register' && <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength="8" required /><small className="field-hint">At least 8 characters.</small></label>}
      {(mode === 'login' || mode === 'reset') && <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'reset' ? 8 : undefined} required /></label>}
      {mode === 'verify' && <>
        <p className="verify-copy">We sent a 6-digit code to <strong>{pending?.email}</strong>. Enter it below to finish creating your account.</p>
        <label>Verification code<input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength="6" placeholder="123456" required /></label>
        <button type="button" className="resend-button" onClick={resendCode} disabled={resendIn > 0}>{resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}</button>
      </>}
      {error && <p className="form-error">{error}</p>}
      {notice && <p className="form-notice">{notice}</p>}
      <button className="auth-submit" disabled={busy}>{submitLabel}</button>
    </form>
    <div className="auth-links">
      {mode === 'login' && <><button onClick={() => { setMode('forgot'); setError(''); setNotice('') }}>Forgot password?</button><button onClick={() => { setMode('register'); setError(''); setNotice('') }}>Create an account</button></>}
      {mode === 'register' && <button onClick={() => { setMode('login'); setError(''); setNotice('') }}>Already have an account? Log in</button>}
      {mode === 'verify' && <button onClick={() => { setMode('register'); setError(''); setNotice(''); setCode('') }}>Use a different email or phone</button>}
      {mode === 'forgot' && <button onClick={() => { setMode('login'); setError(''); setNotice('') }}>Back to log in</button>}
      {mode === 'reset' && <button onClick={() => { window.history.replaceState({}, '', '/'); setMode('login'); setError(''); setNotice('') }}>Back to log in</button>}
    </div>
  </section></main>
}

function ProfilePanel({ session, onClose, onSessionChange, onAccountDeleted }) {
  const [displayName, setDisplayName] = useState(session.user.displayName)
  const [bio, setBio] = useState(session.user.bio || '')
  const [privacy, setPrivacy] = useState(session.user.privacy || { presenceVisible: true, lastSeenVisible: true, contactPermission: 'everyone', findableByPhone: true })
  const [phoneCountry, setPhoneCountry] = useState(session.user.phoneCountry || DEFAULT_COUNTRY)
  const [phoneNumber, setPhoneNumber] = useState('')
  const [message, setMessage] = useState('')

  async function saveProfile(event) {
    event.preventDefault()
    const response = await apiFetch(`/users/me`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName, bio }) })
    const data = await response.json()
    if (response.ok) { onSessionChange({ ...session, user: data.user }); setMessage('Profile saved.') } else setMessage(data.error || 'Could not save profile.')
  }
  async function addPhone(event) {
    event.preventDefault()
    const response = await apiFetch(`/users/me`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phoneNumber, country: phoneCountry }) })
    const data = await response.json()
    if (response.ok) { onSessionChange({ ...session, user: data.user }); setPhoneNumber(''); setMessage('Phone number connected.') } else setMessage(data.error || 'Could not add that phone number.')
  }
  async function uploadAvatar(event) {
    const file = event.target.files?.[0]
    if (!file) return
    const body = new FormData(); body.append('avatar', file)
    const response = await apiFetch(`/users/me/avatar`, { method: 'POST', credentials: 'include', body })
    const data = await response.json()
    if (response.ok) { onSessionChange({ ...session, user: data.user }); setMessage('Profile picture updated.') } else setMessage(data.error || 'Could not upload picture.')
  }
  async function savePrivacy(next) {
    setPrivacy(next)
    const response = await apiFetch(`/users/me/privacy`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })
    if (response.ok) { const saved = await response.json(); onSessionChange({ ...session, user: { ...session.user, privacy: saved } }) }
  }
  async function deleteAccount() {
    if (!window.confirm('Delete your account permanently? Your profile, chats, and media will be removed.')) return
    const response = await apiFetch(`/users/me`, { method: 'DELETE', credentials: 'include' })
    if (response.ok) onAccountDeleted()
    else setMessage('Your account could not be deleted.')
  }

  return <div className="modal-backdrop"><section className="profile-panel">
    <header><h2>Your profile</h2><button onClick={onClose}>×</button></header>
    <form onSubmit={saveProfile}>
      <div className="profile-picture" style={{ backgroundImage: session.user.avatarUrl ? `url(${SERVER_URL}${session.user.avatarUrl})` : undefined }}>{session.user.avatarUrl ? '' : session.user.avatar}</div>
      <label className="upload-status">Change profile photo<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={uploadAvatar} /></label>
      <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength="80" required /></label>
      <label>About<textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength="500" /></label>
      <button className="publish-status">Save profile</button>
    </form>

    <h3>Account</h3>
    <p className="account-line"><span>Email</span><strong>{session.user.email} ✓ verified</strong></p>
    {session.user.phone
      ? <p className="account-line"><span>Phone</span><strong>{session.user.phone}</strong></p>
      : <form className="account-phone-form" onSubmit={addPhone}>
          <label>Connect your phone number<span className="phone-row"><CountryPicker value={phoneCountry} onChange={setPhoneCountry} /><input type="tel" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} placeholder="98765 43210" required /></span></label>
          <button className="publish-status" type="submit">Save phone number</button>
        </form>}

    <h3>Privacy</h3>
    <label className="privacy-option"><input type="checkbox" checked={privacy.presenceVisible} onChange={(event) => savePrivacy({ ...privacy, presenceVisible: event.target.checked })} /> Show online status</label>
    <label className="privacy-option"><input type="checkbox" checked={privacy.lastSeenVisible} onChange={(event) => savePrivacy({ ...privacy, lastSeenVisible: event.target.checked })} /> Show last seen</label>
    <label className="privacy-option"><input type="checkbox" checked={privacy.findableByPhone !== false} onChange={(event) => savePrivacy({ ...privacy, findableByPhone: event.target.checked })} /> Let people find me by phone number</label>
    <label>Who can start new chats?<select value={privacy.contactPermission} onChange={(event) => savePrivacy({ ...privacy, contactPermission: event.target.value })}><option value="everyone">Everyone</option><option value="contacts">Existing contacts only</option><option value="nobody">Nobody</option></select></label>
    {message && <p className="form-notice">{message}</p>}
    <div className="danger-zone">
      <h3>Delete account</h3>
      <p>Removes your profile, chats, and uploaded media permanently. This cannot be undone.</p>
      <button className="danger-button" onClick={deleteAccount}>Delete my account</button>
    </div>
  </section></div>
}

function NewGroupPanel({ chats, currentUserId, onClose, onCreated }) {
  const [name, setName] = useState('')
  const [contacts, setContacts] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    apiFetch('/contacts')
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (!cancelled && data) setContacts(data.contacts || []) })
      .catch(() => { /* Chats can still provide the member list. */ })
    return () => { cancelled = true }
  }, [])

  // People you can add: everyone you already chat with plus every saved
  // contact, merged by account id. Pending phone invites have no id yet.
  const candidates = useMemo(() => {
    const byId = new Map()
    for (const chat of chats) {
      if (chat.group || !chat.otherUserId || chat.otherUserId === currentUserId) continue
      byId.set(chat.otherUserId, { id: chat.otherUserId, displayName: chat.name, avatar: chat.avatar, color: chat.color, avatarUrl: chat.avatarUrl, online: chat.online })
    }
    for (const contact of contacts) {
      if (!contact.id || contact.id === currentUserId) continue
      const existing = byId.get(contact.id) || {}
      byId.set(contact.id, { ...existing, ...contact, displayName: contact.displayName || existing.displayName || contact.formattedPhone })
    }
    return [...byId.values()].sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)))
  }, [chats, contacts, currentUserId])

  function toggleMember(id) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function createGroup(event) {
    event.preventDefault()
    setError('')
    const trimmed = name.trim()
    if (!trimmed) return setError('Give the group a name.')
    if (!selected.size) return setError('Choose at least one person.')
    setBusy(true)
    try {
      const response = await apiFetch('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, memberIds: [...selected] }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not create the group.')
      onCreated(data)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return <div className="modal-backdrop"><section className="new-chat-panel group-panel">
    <header><h2>New group</h2><button onClick={onClose} aria-label="Close">×</button></header>
    <form onSubmit={createGroup}>
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Group name" aria-label="Group name" maxLength="80" />
      <p className="panel-hint">Choose people from your chats and contacts.</p>
      <div className="member-list">
        {candidates.map((candidate) => <label key={candidate.id} className={`member-row ${selected.has(candidate.id) ? 'selected' : ''}`}>
          <input type="checkbox" checked={selected.has(candidate.id)} onChange={() => toggleMember(candidate.id)} />
          <Avatar chat={candidate} />
          <span className="member-name"><strong>{candidate.displayName}</strong><small>{candidate.online ? 'online' : 'add to group'}</small></span>
        </label>)}
        {!candidates.length && <p className="empty-search">Start a chat or save a contact first.</p>}
      </div>
      {error && <p className="form-error">{error}</p>}
      <button className="publish-status" type="submit" disabled={busy || !name.trim() || !selected.size}>{busy ? 'Creating…' : selected.size ? `Create group (${selected.size + 1})` : 'Create group'}</button>
    </form>
  </section></div>
}

function NewChatPanel({ onClose, onCreated, inviterName }) {
  const [country, setCountry] = useState(DEFAULT_COUNTRY)
  const [phone, setPhone] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [contacts, setContacts] = useState([])
  const [invites, setInvites] = useState([])
  const [invite, setInvite] = useState(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function loadContacts() {
    try {
      const response = await apiFetch(`/contacts`, { credentials: 'include' })
      if (!response.ok) return
      const data = await response.json()
      setContacts(data.contacts || [])
      setInvites(data.invites || [])
    } catch { /* Keep the panel usable offline. */ }
  }
  useEffect(() => { loadContacts() }, [])

  async function addContact(event) {
    event.preventDefault()
    setError(''); setNotice(''); setInvite(null); setBusy(true)
    try {
      const response = await apiFetch(`/contacts`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ country, phone, displayName: displayName.trim() || undefined }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not add this contact.')
      setPhone(''); setDisplayName('')
      if (data.chat) { onCreated(data.chat); return }
      setInvite(data)
      setNotice(`${data.formattedPhone} is not on Chat App yet. Send them an invite.`)
      loadContacts()
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  async function openContact(contact) {
    setError('')
    try {
      const response = await apiFetch(`/chats/direct`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: contact.id }) })
      const data = await response.json()
      if (response.ok) onCreated(data)
      else setError(data.error || 'Could not start this chat.')
    } catch { setError('Could not start this chat.') }
  }

  async function removeContact(contact) {
    if (!window.confirm(`Remove ${contact.displayName} from your contacts?`)) return
    const response = await apiFetch(`/contacts/${encodeURIComponent(contact.phone)}`, { method: 'DELETE', credentials: 'include' })
    if (response.ok) { setContacts((current) => current.filter((item) => item.phone !== contact.phone)); setInvites((current) => current.filter((item) => item.phone !== contact.phone)) }
  }

  async function copyInvite(url) {
    try {
      await navigator.clipboard.writeText(url)
      setNotice('Invite link copied.')
    } catch { window.prompt('Copy this invite link:', url) }
  }

  function shareOnWhatsApp(url) {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const pendingByPhone = new Map(invites.map((item) => [item.phone, item]))
  const shareUrl = (contact) => pendingByPhone.get(contact.phone)?.inviteUrl || `${window.location.origin}/?phone=${encodeURIComponent(contact.phone)}`
  const whatsappUrl = (contact, name = inviterName || 'A friend') => `https://wa.me/${contact.phone.replace(/^\+/, '')}?text=${encodeURIComponent(`Hi! ${name} invited you to chat on Chat App. Open ${shareUrl(contact)} to create your account.`)}`

  return <div className="modal-backdrop"><section className="new-chat-panel">
    <header><h2>New chat</h2><button onClick={onClose}>×</button></header>
    <form className="add-contact-form" onSubmit={addContact}>
      <p className="panel-hint">Add someone by their phone number. If they are not on Chat App yet, you can invite them.</p>
      <span className="phone-row"><CountryPicker value={country} onChange={setCountry} /><input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="98765 43210" aria-label="Contact phone number" required /></span>
      <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Name (optional)" aria-label="Contact name" maxLength="80" />
      <button className="publish-status" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add contact'}</button>
      {error && <p className="form-error">{error}</p>}
      {notice && <p className="form-notice">{notice}</p>}
      {invite && <div className="invite-actions">
        <button type="button" onClick={() => shareOnWhatsApp(invite.whatsappUrl)}>Share on WhatsApp</button>
        <button type="button" onClick={() => copyInvite(invite.inviteUrl)}>Copy invite link</button>
      </div>}
    </form>

    <h3 className="contact-heading">Saved contacts</h3>
    <div className="user-results">
      {contacts.map((contact) => <article className="contact-row" key={contact.phone}>
        <Avatar chat={contact} />
        <button className="contact-open" onClick={() => contact.registered ? openContact(contact) : null} disabled={!contact.registered}>
          <strong>{contact.displayName}</strong>
          <small>{contact.registered ? contact.formattedPhone : `${contact.formattedPhone} · invite pending`}</small>
        </button>
        {contact.registered
          ? <button className="contact-action" onClick={() => openContact(contact)}>Chat</button>
          : <><button className="contact-action" onClick={() => shareOnWhatsApp(whatsappUrl(contact))}>WhatsApp</button><button className="contact-action" onClick={() => copyInvite(shareUrl(contact))}>Copy</button></>}
        <button className="contact-remove" onClick={() => removeContact(contact)} aria-label={`Remove ${contact.displayName}`}>×</button>
      </article>)}
      {!contacts.length && <p className="empty-search">No contacts yet. Add a phone number above.</p>}
    </div>

    {invites.length > 0 && <><h3 className="contact-heading">Pending invites</h3>
      <div className="user-results">
        {invites.map((item) => <article className="contact-row" key={item.phone}>
          <Avatar chat={{ avatar: '?', color: '#597d90' }} />
          <div className="contact-open"><strong>{item.formattedPhone}</strong><small>Waiting for them to join</small></div>
          <button className="contact-action" onClick={() => shareOnWhatsApp(`https://wa.me/${item.phone.replace(/^\+/, '')}?text=${encodeURIComponent(`Hi! I invited you to chat on Chat App. Open ${item.inviteUrl} to create your account.`)}`)}>WhatsApp</button>
          <button className="contact-action" onClick={() => copyInvite(item.inviteUrl)}>Copy</button>
        </article>)}
      </div></>}
  </section></div>
}

function App() {
  const [session, setSession] = useState(null)
  const [authToken, setAuthToken] = useState(() => sessionToken())
  const [checkingSession, setCheckingSession] = useState(true)
  const [waking, setWaking] = useState(false)
  useEffect(() => {
    // The old build shared one token through localStorage; drop it so tabs stop
    // inheriting each other's account.
    try { localStorage.removeItem(SESSION_KEY) } catch { /* Storage can be unavailable. */ }
    let cancelled = false
    // A cold Render instance can fail the very first request; retry it so the
    // user lands on their chats instead of a login screen they cannot use.
    apiFetchWithWakeRetry('/auth/me', {}, () => { if (!cancelled) setWaking(true) })
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => { if (!cancelled && data) setSession(data) })
      .catch(() => { /* Offline: show the login screen instead of hanging. */ })
      .finally(() => { if (!cancelled) { setCheckingSession(false); setWaking(false) } })
    return () => { cancelled = true }
  }, [authToken])
  function authenticated(data) {
    if (data.token) { try { sessionStorage.setItem(SESSION_KEY, data.token) } catch { /* Keep the in-memory session. */ } setAuthToken(data.token) }
    setSession(data)
    if (window.location.search) window.history.replaceState({}, '', window.location.pathname)
  }
  async function logout() {
    await apiFetch('/auth/logout', { method: 'POST' })
    try { sessionStorage.removeItem(SESSION_KEY) } catch { /* Storage can be unavailable. */ }
    setAuthToken('')
    setSession(null)
  }
  if (checkingSession) return <main className="auth-page"><p className="session-loading">{waking ? 'Waking the chat server…' : 'Loading Chat App…'}</p></main>
  return session ? <ChatWorkspace session={session} authToken={authToken} onLogout={logout} onSessionChange={setSession} /> : <AuthScreen onAuthenticated={authenticated} />
}

export default App
