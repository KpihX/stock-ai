# CALL.md - WhatsApp voice calls in Stockline

Integration guide for receiving a WhatsApp call from a customer, answering it from the admin panel, and exchanging live audio with the caller.

## 1. Goal and scope

A customer calls the WhatsApp number paired with the application. The admin sees an incoming call banner in the app, clicks Answer, speaks through the browser microphone, and hears the caller through the browser speakers. The audio is not sent through the public telephone network. It travels through the WhatsApp Web VoIP stack.

The number that receives the call is the one the admin paired by scanning the QR code in the admin panel. It is not a static value in the code or in `config.jsonc`. The pairing stores the credentials in `wa_session/<phone>/`, the listener opens a Baileys socket with those credentials, and `call.incoming` arrives on that socket. The project supports several numbers, each with its own socket and session directory, listed in the admin account table.

Two providers are supported:

| Provider | Cost | Status |
|---|---|---|
| `browser_webrtc` | free | microphone fallback in the browser, no real WhatsApp call |
| `baileys_voip` | free | active production bridge via `@innovatorssoft/baileys` + `werift` 48 kHz Opus |

The provider is selected in `backend/config.jsonc` under `selection.calls` (with generic parameters under `settings.calls`). Never hardcode it.

## 2. Production Implementation Notes (Shipped)

The active VoIP pipeline in `backend/wa/src/voip.ts` and `backend/wa/src/webrtc-bridge.ts` upgrades the initial raw WebSocket PCM proposal to a true bidirectional WebRTC bridge:

- Uses `await sock.getVoipClient()` (single built-in client on the existing Baileys socket) plus `backend/wa/scripts/patch-baileys-voip.mjs` (`postinstall`) so WASM `eventType === 2` does not tear down ringing calls prematurely.
- Bridges caller 16 kHz PCM <-> 48 kHz Opus WebRTC (`werift` + `opusscript`) directly to `frontend/src/components/CallPanel.tsx`.
- Segments caller utterances with RMS VAD (`vad_rms_threshold`, `vad_silence_ms`, `vad_max_utterance_ms` in `backend/config.jsonc`) and transcribes each chunk in sequence (`utterance_seq`) via the active STT provider (`nvidia_whisper` / `nvidia_parakeet`), waiting for `in_flight` STT jobs before auto-committing the order on hangup.

## 2. How the target provider works

`@innovatorssoft/baileys` version 7.4.9 or newer embeds the WhatsApp Web VoIP stack:

```
 WhatsApp socket (Baileys)
        |
        +-- SignalingBridge    XMPP handshake, offer, preaccept, accept, transport
        +-- RelayRtcTransport  UDP packets to the WhatsApp relays
        +-- WasmEngine         WhatsApp Web WASM, Opus, DTLS, SRTP
        |      +-- worker_threads, pthreadPoolSize 4 by default
        +-- AudioFeeder        PCM 16 kHz to WASM, outbound audio
        +-- CallManager        call lifecycle and concurrency limit
```

The audio never leaves the Node process as a file. It is exposed as `Float32Array` chunks at 16 kHz mono:

```
 caller voice --> WASM --> session.on('audio', pcm) --> WebSocket --> browser AudioContext
 admin mic   --> getUserMedia --> WebSocket --> call.engine.sendAudioData(chunk, ptr) --> WASM --> caller
```

Key API from the library source:

| Symbol | Role |
|---|---|
| `initWithSocket(sock)` | attach the VoIP client to the existing Baileys socket, avoids a second session |
| `sock.ev.on('call.incoming', session)` | incoming call event, exposes `callId`, `peerJid`, `isVideo`, `isWaiting` |
| `session.accept({ audioSource, repeatAudio })` | answer the call, optional file played on answer |
| `sock.acceptCall(callId, options)` | same action through the socket |
| `session.on('audio', pcmChunk)` | decrypted inbound PCM from the caller |
| `session.on('stateChange', ...)` | lifecycle events: accepted, connected, audioReady, streaming, ended |
| `call.startAudio(rate, channels, frames, callback)` | callback supplies live PCM chunks to send to the caller |
| `sock.endCall(callId)` | hang up |

Use `audioSource: 'silence'` when answering, then drive the outbound audio through `startAudio` and `sendAudioData`.

## 3. Prerequisites

1. A dedicated WhatsApp number paired with the application. Do not use the number currently active on the admin phone, otherwise the call rings on both devices.
2. Node.js 20 or newer. The runtime image already provides Node 22.
3. `ffmpeg` on PATH. Add it to the runtime stage of `backend/Dockerfile`.
4. Enough memory for the WASM stack and four worker threads per active call.
5. The WASM assets shipped by the package under `assets/wasm/`. They are extracted at startup by `ensureWasmAssets()`.

## 4. Configuration

Add a calls block to `backend/config.jsonc`:

```jsonc
"calls": {
  "provider": "baileys_voip",
  "max_concurrent_calls": 1,
  "pthread_pool_size": 4,
  "answer_source": "silence",
  "sample_rate": 16000,
  "channels": 1,
  "frames_per_chunk": 320
}
```

All values are generic. Provider specific defaults stay in `providers.py` if a brick is added there. No phone number and no secret belongs in this file.

## 5. Backend integration, step by step

All changes happen in `backend/wa/src/index.ts`. Use the existing multi-account session map.

### Step 1 dependency

In `backend/wa/package.json`, replace `@whiskeysockets/baileys` with `@innovatorssoft/baileys` at version 7.4.9 or newer. Run npm install, then confirm the TypeScript build with `npx tsc --noEmit`.

### Step 2 attach the VoIP client

After a Baileys socket connects for a phone, attach the VoIP client to that same socket:

```ts
const voip = new VoipClient({
  maxConcurrentCalls: 1,
  pthreadPoolSize: 4,
  diagnostic: false,
})
await voip.initWithSocket(sock)
```

Do not call `connect()` on the VoIP client in this case. It would create a second WhatsApp session and could trigger a 440 disconnect.

### Step 3 incoming call event

```ts
sock.ev.on('call.incoming', async (session) => {
  const callId = session.callId
  const from = session.peerJid
  const phone = canonicalPhone(from)
  publishToFrontend(phone, { type: 'call.incoming', call_id: callId, from })
})
```

`publishToFrontend` is the existing SSE or WebSocket publisher used by `events.py`. The admin panel must receive the event within one second.

### Step 4 answer, reject, hang up

Add three HTTP endpoints in the Wa listener, all taking `phone` and `call_id`:

```
POST /call/accept   -> voip.acceptCall(callId, { audioSource: 'silence' })
POST /call/reject   -> voip.rejectCall(callId, 'declined')
POST /call/hangup   -> voip.endCall(callId)
```

Proxy them from `backend/src/stockline_ai/api/admin.py` with the same pattern as the WhatsApp account routes, using `_admin` as dependency. The frontend calls the FastAPI routes, never the Wa listener directly.

### Step 5 relay inbound audio

```ts
session.on('audio', (pcm: Float32Array) => {
  publishBinaryToFrontend(phone, callId, Buffer.from(pcm.buffer))
})
```

Use WebSocket binary frames. Base64 JSON is acceptable for the first prototype but adds about 33 percent overhead.

### Step 6 relay outbound audio

On the first `call.incoming`, call `call.startAudio(16000, 1, 320, callback)`. The callback is invoked by the library when it needs a chunk. Feed it from a bounded queue filled by the frontend WebSocket microphone frames:

```ts
const outbound = new Float32Array(320)
const length = micQueue.drain(outbound)
callback(length ? outbound : new Float32Array(320))
```

A 320 frame buffer at 16 kHz equals 20 ms of audio. The queue must never grow beyond roughly 200 ms. Drop oldest frames when full.

### Step 7 frontend

`frontend/src/components/CallPanel.tsx` already owns the call tab. Extend it:

1. Listen for `call.incoming` and show an incoming banner with the caller number.
2. Buttons Answer and Reject call the FastAPI routes from step 4.
3. After answer, open `callSocketUrl(callId)` from `frontend/src/api.ts`.
4. Create one `AudioContext` at 16 kHz. For each binary frame, build an `AudioBuffer` from the `Float32Array` and enqueue it in a playback queue. Do not create a new context per frame.
5. Capture the admin microphone with `getUserMedia`, resample to 16 kHz mono through an `AudioWorklet`, and send 20 ms frames over the WebSocket.
6. On `ended`, close the socket, stop the tracks, and clear the banner.

## 6. Test procedure

1. Pair the dedicated demo number in the admin panel and confirm status `connected`.
2. Check the Wa logs for the pairing and the socket `open` line.
3. From a second WhatsApp account, call the demo number.
4. Confirm `call.incoming` appears in the admin within one second.
5. Click Answer. Confirm the caller hears the silence source first, then the admin microphone.
6. Confirm the admin hears the caller with no metallic artifacts. If the audio is chopped, raise the queue size or check the event loop is not blocked.
7. Hang up from both sides and confirm the `ended` event clears the UI.

## 7. Risks and fallback

| Risk | Mitigation |
|---|---|
| Fork is unofficial and may break with a WhatsApp Web update | Pin the exact npm version, keep `browser_webrtc` fallback |
| WASM memory growth | One call at a time by default, destroy the engine on `ended` |
| Call rings on the admin physical phone too | Use a dedicated number for the demo |
| Audio latency above 300 ms | Use binary frames, 20 ms chunks, avoid JSON base64 |
| Browser autoplay policy blocks audio |Resume the AudioContext inside the Answer click handler |

If the fork fails during the hackathon, keep the existing browser WebRTC demo. It already covers the message saying the client is on the line, with Whisper and EdgeTTS, without a real WhatsApp call.

## 8. Out of scope

Group calls, video calls, call recording, caller ID spoofing, and public telephone numbers are not part of this integration.

Do not spoof the customer number as caller ID. The Truth in Caller ID Act prohibits misleading caller identification when used to defraud or obtain value. Always display the number the application owns.
