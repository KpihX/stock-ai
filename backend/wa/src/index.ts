/**
 * Minimal WhatsApp listener for Stockline, inspired by the whats-proxy daemon.
 *
 * Responsibilities, copied from the essential parts of whats-proxy:
 *  - persist Baileys auth state on a mounted volume (useMultiFileAuthState)
 *  - receive inbound messages through messages.upsert
 *  - extract text, voice and image into a Signal
 *  - POST the Signal to the FastAPI webhook
 *  - expose a tiny HTTP endpoint for sending acknowledgements
 *
 * This package is self-contained and does not import from any external repo.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import makeWASocket, {
  type AnyMessageContent,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'

const API_URL = process.env.STOCKLINE_API_URL || 'http://api:8000'
const STATE_DIR = process.env.WHATS_PROXY_STATE_DIR || '/app/wa-state'
const PORT = Number(process.env.WA_PORT || 3001)
const PHONE = process.env.STOCKLINE_PHONE || ''

interface Signal {
  evenement_id: string
  capture_le: string
  canal: string
  actor_ref: string
  modality: string
  texte: string
  cNumber: string
  message_id: string
  media_path?: string
}

interface SendRequest {
  jid: string
  text: string
}

let sock: ReturnType<typeof makeWASocket> | null = null
let currentQr: { dataUrl: string; at: number } | null = null
let status = 'disconnected'
const seenMessageIds = new Set<string>()

function canonicalPhone(value: string): string {
  const userPart = value.split('@')[0].split(':')[0]
  return userPart.replace(/[^0-9]/g, '')
}

function resolveSenderPhone(key: any): string {
  const alt = key?.remoteJidAlt || key?.senderPn || ''
  if (typeof alt === 'string' && alt.endsWith('@s.whatsapp.net')) {
    return canonicalPhone(alt)
  }
  const jid = String(key?.remoteJid || '')
  if (jid.endsWith('@s.whatsapp.net')) {
    return canonicalPhone(jid)
  }
  if (jid.endsWith('@lid')) {
    const lid = canonicalPhone(jid)
    const reverseFile = join(STATE_DIR, `lid-mapping-${lid}_reverse.json`)
    if (existsSync(reverseFile)) {
      try {
        const mapped = JSON.parse(readFileSync(reverseFile, 'utf8'))
        if (typeof mapped === 'string' && mapped.trim()) {
          return canonicalPhone(mapped)
        }
      } catch (error) {
        console.error('[wa] lid reverse lookup failed', error)
      }
    }
    return lid
  }
  return canonicalPhone(jid)
}

function unwrapMessage(raw: any): any {
  if (!raw) return raw
  if (raw.ephemeralMessage?.message) return unwrapMessage(raw.ephemeralMessage.message)
  if (raw.viewOnceMessage?.message) return unwrapMessage(raw.viewOnceMessage.message)
  if (raw.viewOnceMessageV2?.message) return unwrapMessage(raw.viewOnceMessageV2.message)
  return raw
}

function extract(rawMessage: any): { text: string; modality: string } {
  const message = unwrapMessage(rawMessage)
  if (message?.conversation) return { text: message.conversation, modality: 'text' }
  if (message?.extendedTextMessage?.text) {
    return { text: message.extendedTextMessage.text, modality: 'text' }
  }
  if (message?.audioMessage || message?.voiceMessage) {
    return { text: '[voice]', modality: 'audio' }
  }
  if (message?.imageMessage) {
    const caption = String(message.imageMessage.caption || '').trim()
    return { text: caption || '[image]', modality: 'image' }
  }
  return { text: '', modality: 'unknown' }
}

async function postSignal(signal: Signal): Promise<void> {
  try {
    const response = await fetch(`${API_URL}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signal),
    })
    if (!response.ok) console.error(`[wa] webhook ${response.status}`)
  } catch (error) {
    console.error('[wa] webhook failed', error)
  }
}

async function connect(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(STATE_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    browser: ['Stockline', 'Chrome', '1.0.0'],
  })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update: any) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      status = 'qr_pending'
      QRCode.toDataURL(qr)
        .then((dataUrl: string) => {
          currentQr = { dataUrl, at: Date.now() }
          console.log('[wa] QR ready for pairing')
        })
        .catch((error: unknown) => console.error('[wa] QR render failed', error))
    }
    if (connection === 'close') {
      status = 'disconnected'
      currentQr = null
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) void connect()
    }
    if (connection === 'open') {
      status = 'connected'
      currentQr = null
      console.log(`[wa] connected as ${sock?.user?.id || '?'}`)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
    if (type !== 'notify') return
    for (const message of messages) {
      if (!message.message || message.key.fromMe) continue
      const msgId = String(message.key.id || '')
      if (msgId) {
        if (seenMessageIds.has(msgId)) {
          console.log(`[wa] skipping duplicate message ${msgId}`)
          continue
        }
        seenMessageIds.add(msgId)
        if (seenMessageIds.size > 2000) {
          const oldest = seenMessageIds.values().next().value
          if (oldest) seenMessageIds.delete(oldest)
        }
      }
      const jid = String(message.key.remoteJid || '')
      if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid === 'status@broadcast') {
        continue
      }
      const cNumber = resolveSenderPhone(message.key)
      if (!cNumber) continue
      if (PHONE && cNumber !== canonicalPhone(PHONE)) continue
      const { text, modality } = extract(message.message)
      if (!text || modality === 'unknown') continue
      let mediaPath = ''
      if (modality === 'audio' || modality === 'image') {
        try {
          const safeId = (msgId || `evt_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '')
          const ext = modality === 'audio' ? 'ogg' : 'png'
          mediaPath = `/tmp/wa_media_${safeId}.${ext}`
          const buffer = await downloadMediaMessage(message, 'buffer', {})
          writeFileSync(mediaPath, buffer as Buffer)
          console.log(
            `[wa] saved ${modality} media (${(buffer as Buffer).length} bytes) to ${mediaPath}`
          )
        } catch (error) {
          console.error(`[wa] ${modality} media download failed`, error)
          mediaPath = ''
        }
      }
      const signal: Signal = {
        evenement_id: msgId || `evt_${Date.now()}`,
        capture_le: new Date().toISOString(),
        canal: 'whatsapp',
        actor_ref: cNumber,
        modality,
        texte: text,
        cNumber,
        message_id: msgId,
        media_path: mediaPath,
      }
      console.log(
        `[wa] posting signal id=${signal.evenement_id} phone=${cNumber} modality=${modality} media=${mediaPath || 'none'}`
      )
      await postSignal(signal)
    }
  })
}

function sendJson(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    request.on('data', (chunk) => (data += chunk))
    request.on('end', () => resolve(data))
  })
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { status: 'ok', connected: sock !== null })
    return
  }
  if (request.method === 'GET' && request.url === '/status') {
    sendJson(response, 200, {
      status,
      phone: sock?.user?.id || '',
      qr_ready: currentQr !== null,
    })
    return
  }
  if (request.method === 'GET' && request.url === '/qr') {
    if (!currentQr || Date.now() - currentQr.at > 300_000) {
      sendJson(response, 404, { error: 'no QR available' })
      return
    }
    sendJson(response, 200, { qr: currentQr.dataUrl })
    return
  }
  if (request.method === 'POST' && request.url === '/connect') {
    if (!sock) void connect()
    sendJson(response, 200, { status: 'connecting' })
    return
  }
  if (request.method === 'POST' && request.url === '/disconnect') {
    sock?.ws?.close()
    sock = null
    status = 'disconnected'
    currentQr = null
    sendJson(response, 200, { status: 'disconnected' })
    return
  }
  if (request.method === 'POST' && request.url === '/send') {
    try {
      const body = JSON.parse(await readBody(request)) as SendRequest
      if (!sock || status !== 'connected') {
        sendJson(response, 503, { error: 'not connected' })
        return
      }
      const rawJid = String(body.jid || '').trim()
      const targetJid = rawJid.includes('@') ? rawJid : `${canonicalPhone(rawJid)}@s.whatsapp.net`
      const content: AnyMessageContent = { text: body.text }
      await sock.sendMessage(targetJid, content)
      console.log(`[wa] sent notification to ${targetJid}`)
      sendJson(response, 200, { status: 'sent', jid: targetJid })
    } catch (error) {
      console.error('[wa] /send failed', error)
      sendJson(response, 502, { error: String(error) })
    }
    return
  }
  sendJson(response, 404, { error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[wa] ack API listening on ${PORT}`)
  void connect()
})
