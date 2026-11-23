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
import {
  type AnyMessageContent,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from '@innovatorssoft/baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import { VoipBridgeManager } from './voip.js'
import type { BridgeConfig } from './webrtc-bridge.js'

const API_URL = process.env.STOCKLINE_API_URL || 'http://api:8000'
const STATE_DIR = process.env.WHATS_PROXY_STATE_DIR || '/app/wa-state'
const PORT = Number(process.env.WA_PORT || 3001)
const PHONE = process.env.STOCKLINE_PHONE || ''

function stripJsonComments(raw: string): string {
  let out = ''
  let inStr = false
  let esc = false
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    const next = raw[i + 1]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      i += 1
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function loadCallsConfig(): {
  bridgeConfig: BridgeConfig
  maxConcurrentCalls: number
  pthreadPoolSize: number
} {
  const candidates = ['/app/config.jsonc', join(process.cwd(), '../config.jsonc')]
  let calls: Record<string, any> = {}
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(stripJsonComments(readFileSync(path, 'utf8')))
        calls = parsed?.settings?.calls || {}
        break
      } catch (err) {
        console.warn('[wa] failed to parse config.jsonc', err)
      }
    }
  }
  return {
    maxConcurrentCalls: Number(calls.max_concurrent_calls ?? 1),
    pthreadPoolSize: Number(calls.pthread_pool_size ?? 4),
    bridgeConfig: {
      sampleRate: Number(calls.sample_rate ?? 16000),
      webrtcRate: Number(calls.webrtc_rate ?? 48000),
      channels: Number(calls.channels ?? 1),
      framesPerChunk: Number(calls.frames_per_chunk ?? 320),
      vadRmsThreshold: Number(calls.vad_rms_threshold ?? 0.012),
      vadSilenceMs: Number(calls.vad_silence_ms ?? 1100),
      vadMaxUtteranceMs: Number(calls.vad_max_utterance_ms ?? 12000),
      icePortMin: Number(calls.ice_port_min ?? 40000),
      icePortMax: Number(calls.ice_port_max ?? 40020),
      iceServers: Array.isArray(calls.ice_servers)
        ? calls.ice_servers.map(String)
        : ['stun:stun.l.google.com:19302'],
    },
  }
}

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

function resolvePhoneFromJid(jid: string): string {
  if (!jid) return ''
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

function resolveSenderPhone(key: any): string {
  const alt = key?.remoteJidAlt || key?.senderPn || ''
  if (typeof alt === 'string' && alt.endsWith('@s.whatsapp.net')) {
    return canonicalPhone(alt)
  }
  return resolvePhoneFromJid(String(key?.remoteJid || ''))
}

const callsCfg = loadCallsConfig()
const voipManager = new VoipBridgeManager({
  apiUrl: API_URL,
  bridgeConfig: callsCfg.bridgeConfig,
  maxConcurrentCalls: callsCfg.maxConcurrentCalls,
  pthreadPoolSize: callsCfg.pthreadPoolSize,
  resolvePhone: resolvePhoneFromJid,
})

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

  const createWASocket = ((makeWASocket as any)?.default ?? makeWASocket) as typeof makeWASocket
  const activeSock = createWASocket({
    version,
    auth: state,
    browser: ['Stockline', 'Chrome', '1.0.0'],
    voip: {
      maxConcurrentCalls: callsCfg.maxConcurrentCalls,
      pthreadPoolSize: callsCfg.pthreadPoolSize,
    },
  } as any)
  sock = activeSock
  activeSock.ev.on('creds.update', saveCreds)

  activeSock.ev.on('connection.update', (update: any) => {
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
      console.log(`[wa] connected as ${activeSock.user?.id || '?'}`)
      void voipManager.attachSocket(activeSock)
    }
  })

  activeSock.ev.on('messages.upsert', async ({ messages, type }: any) => {
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
  if (request.method === 'GET' && request.url === '/calls') {
    sendJson(response, 200, { items: voipManager.listCalls() })
    return
  }
  if (request.method === 'POST' && request.url === '/call/accept') {
    try {
      const body = JSON.parse(await readBody(request)) as { call_id: string; sdp_offer: string }
      const result = await voipManager.acceptCall(String(body.call_id || ''), String(body.sdp_offer || ''))
      sendJson(response, 200, result)
    } catch (error) {
      console.error('[wa] /call/accept failed', error)
      sendJson(response, 400, { error: String(error) })
    }
    return
  }
  if (request.method === 'POST' && request.url === '/call/reject') {
    try {
      const body = JSON.parse(await readBody(request)) as { call_id: string; reason?: string }
      const result = await voipManager.rejectCall(String(body.call_id || ''), body.reason || 'declined')
      sendJson(response, 200, result)
    } catch (error) {
      sendJson(response, 400, { error: String(error) })
    }
    return
  }
  if (request.method === 'POST' && request.url === '/call/hangup') {
    try {
      const body = JSON.parse(await readBody(request)) as { call_id: string; reason?: string }
      const result = await voipManager.hangupCall(String(body.call_id || ''), body.reason || 'completed')
      sendJson(response, 200, result)
    } catch (error) {
      sendJson(response, 400, { error: String(error) })
    }
    return
  }
  if (request.method === 'POST' && request.url === '/call/mute') {
    try {
      const body = JSON.parse(await readBody(request)) as { call_id: string; muted: boolean }
      const result = voipManager.setMuted(String(body.call_id || ''), Boolean(body.muted))
      sendJson(response, 200, result)
    } catch (error) {
      sendJson(response, 400, { error: String(error) })
    }
    return
  }
  if (request.method === 'POST' && request.url === '/call/simulate') {
    try {
      const body = JSON.parse(await readBody(request)) as {
        from: string
        wav_base64?: string
        call_id?: string
      }
      const result = await voipManager.simulateIncomingCall({
        from: String(body.from || ''),
        wavBase64: body.wav_base64,
        callId: body.call_id,
      })
      sendJson(response, 200, result)
    } catch (error) {
      console.error('[wa] /call/simulate failed', error)
      sendJson(response, 400, { error: String(error) })
    }
    return
  }
  if (request.method === 'POST' && request.url === '/call/inject-audio') {
    try {
      const body = JSON.parse(await readBody(request)) as { call_id: string; wav_base64: string }
      const result = voipManager.injectCallerAudio(
        String(body.call_id || ''),
        String(body.wav_base64 || '')
      )
      sendJson(response, 200, result)
    } catch (error) {
      sendJson(response, 400, { error: String(error) })
    }
    return
  }
  sendJson(response, 404, { error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[wa] ack API listening on ${PORT}`)
  void connect()
})
