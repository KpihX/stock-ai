import { useEffect, useMemo, useRef, useState } from "react";
import { api, callSocketUrl } from "../api";
import type { ClientAccount, IncomingCallState } from "../types";

interface TranscriptEntry {
  id: number;
  speaker: "system" | "assistant";
  text: string;
}

interface CallPanelProps {
  activeCall: IncomingCallState | null;
  recentCalls: IncomingCallState[];
  selectedCallId: string | null;
  webrtcState: string;
  callBusy: boolean;
  clients: ClientAccount[];
  onSelectCall: (callId: string) => void;
  onInspectCommand: (commandId: string) => void;
  onAnswer: (callId: string) => void;
  onReject: (callId: string) => void;
  onHangup: (callId: string) => void;
  onToggleMute: (callId: string, muted: boolean) => void;
  onCommitOrder: (callId: string) => void;
  onSimulateCall: (phone: string, text: string) => Promise<void>;
  onInjectText: (
    callId: string,
    text: string,
    speaker: "client" | "manager",
  ) => Promise<void>;
}

function formatCallTime(value?: string | null): string {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function callStatusTone(status?: string): string {
  const s = String(status || "").toLowerCase();
  if (s === "active") return "ok";
  if (s === "ringing") return "warn";
  if (s === "rejected") return "bad";
  return "";
}

export default function CallPanel({
  activeCall,
  recentCalls,
  selectedCallId,
  webrtcState,
  callBusy,
  clients,
  onSelectCall,
  onInspectCommand,
  onAnswer,
  onReject,
  onHangup,
  onToggleMute,
  onCommitOrder,
  onSimulateCall,
  onInjectText,
}: CallPanelProps) {
  const [callId, setCallId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [simPhone, setSimPhone] = useState(clients[0]?.phone_number || "33745746025");
  const [simText, setSimText] = useState(
    "Bonjour, je voudrais commander 6 kilos de tomates grappe et 4 pains de campagne pour demain matin.",
  );
  const [injectText, setInjectText] = useState(
    "Ajoute aussi 3 filets de cabillaud s'il te plaît.",
  );
  const [injectSpeaker, setInjectSpeaker] = useState<"client" | "manager">("client");
  const [simBusy, setSimBusy] = useState(false);
  const [historyDetail, setHistoryDetail] = useState<IncomingCallState | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (clients.length > 0 && !clients.some((c) => c.phone_number === simPhone)) {
      setSimPhone(clients[clients.length - 1].phone_number);
    }
  }, [clients, simPhone]);

  const effectiveSelectedId = useMemo(
    () => selectedCallId || recentCalls[0]?.call_id || null,
    [selectedCallId, recentCalls],
  );

  useEffect(() => {
    if (!effectiveSelectedId) {
      setHistoryDetail(null);
      return;
    }
    const cached = recentCalls.find((c) => c.call_id === effectiveSelectedId) || null;
    if (cached) setHistoryDetail(cached);
    let cancelled = false;
    setHistoryLoading(true);
    void api
      .getCallDetail(effectiveSelectedId)
      .then((detail) => {
        if (!cancelled) setHistoryDetail(detail);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveSelectedId, recentCalls]);

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const counterRef = useRef(0);

  function pushEntry(speaker: TranscriptEntry["speaker"], text: string) {
    counterRef.current += 1;
    setEntries((current) => [...current, { id: counterRef.current, speaker, text }]);
  }

  function teardown() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    setConnected(false);
  }

  useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      socketRef.current?.close();
    };
  }, []);

  function handleSocketMessage(event: MessageEvent) {
    const data: unknown = event.data;
    if (typeof data === "string") {
      let text = data;
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (parsed.type === "error" && typeof parsed.error === "string") {
          setError(parsed.error);
          pushEntry("system", `Error: ${parsed.error}`);
          return;
        }
        if (typeof parsed.text === "string") {
          text = parsed.text;
        } else if (typeof parsed.transcript === "string") {
          text = parsed.transcript;
        }
      } catch {
        // Display the raw string when it is not JSON.
      }
      pushEntry("assistant", text);
      return;
    }
    if (data instanceof Blob || data instanceof ArrayBuffer) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      void audio.play().catch(() => undefined);
      pushEntry("system", "Audio response received");
    }
  }

  async function startCall() {
    setError("");
    setBusy(true);
    try {
      const result = await api.createCall();
      const id = result.call_id;
      setCallId(id);

      const socket = new WebSocket(callSocketUrl(id));
      socketRef.current = socket;
      socket.onopen = () => {
        setConnected(true);
        pushEntry("system", `Connected to call ${id}`);
      };
      socket.onmessage = handleSocketMessage;
      socket.onerror = () => setError("WebSocket connection error");
      socket.onclose = () => setConnected(false);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (socket.readyState === WebSocket.OPEN && event.data.size > 0) {
          void event.data.arrayBuffer().then((buffer) => socket.send(buffer));
        }
      };
      recorder.start(250);
    } catch (cause) {
      teardown();
      setError(cause instanceof Error ? cause.message : "Unable to start call");
    } finally {
      setBusy(false);
    }
  }

  function stopCall() {
    teardown();
    pushEntry("system", "Call ended");
  }

  return (
    <div className="call-panel">
      <div className="call-controls">
        <div className="panel-head">
          <div>
            <h2>WhatsApp WebRTC Call Desk</h2>
            <p className="muted">
              Inbound WhatsApp calls ring directly in this interface over WebRTC Opus (48 kHz, AEC/NS) with live Whisper transcription and Nemotron order extraction.
            </p>
          </div>
          <span
            className={`pill ${
              activeCall?.status === "active"
                ? "ok"
                : activeCall?.status === "ringing"
                  ? "warn"
                  : "muted"
            }`}
          >
            <span className="dot" />
            {activeCall
              ? `${activeCall.status.toUpperCase()} · ${webrtcState || "idle"}`
              : "Standby · Waiting for customer call"}
          </span>
        </div>

        {activeCall ? (
          <div className="live-call-card">
            <div className="live-call-meta">
              <div>
                <div className="live-call-caller">
                  <strong>{activeCall.client_name}</strong>
                  <span className="mono muted"> · {activeCall.phone_number}</span>
                  {activeCall.client_id && (
                    <span className="pill ok">{activeCall.client_id}</span>
                  )}
                </div>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                  Call <span className="mono">{activeCall.call_id}</span> · Mode{" "}
                  <span className="mono">{activeCall.mode}</span> · Transport{" "}
                  <span className="mono">WebRTC Opus 48kHz ({webrtcState})</span>
                </div>
              </div>
              <div className="row-actions">
                {activeCall.status === "ringing" ? (
                  <>
                    <button
                      className="btn primary"
                      type="button"
                      disabled={callBusy}
                      onClick={() => onAnswer(activeCall.call_id)}
                    >
                      {callBusy ? "Connecting..." : "Answer call"}
                    </button>
                    <button
                      className="btn reject"
                      type="button"
                      disabled={callBusy}
                      onClick={() => onReject(activeCall.call_id)}
                    >
                      Reject
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() =>
                        onToggleMute(activeCall.call_id, !activeCall.muted)
                      }
                    >
                      {activeCall.muted ? "Unmute mic" : "Mute mic"}
                    </button>
                    <button
                      className="btn primary"
                      type="button"
                      disabled={
                        activeCall.committed || activeCall.transcripts.length === 0
                      }
                      onClick={() => onCommitOrder(activeCall.call_id)}
                    >
                      {activeCall.committed ? "Order extracted" : "Extract order"}
                    </button>
                    <button
                      className="btn reject"
                      type="button"
                      onClick={() => onHangup(activeCall.call_id)}
                    >
                      Hang up
                    </button>
                  </>
                )}
              </div>
            </div>

            {activeCall.status === "active" && (
              <form
                className="call-inject-row"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!injectText.trim()) return;
                  setSimBusy(true);
                  try {
                    await onInjectText(
                      activeCall.call_id,
                      injectText.trim(),
                      injectSpeaker,
                    );
                  } finally {
                    setSimBusy(false);
                  }
                }}
              >
                <select
                  value={injectSpeaker}
                  onChange={(e) =>
                    setInjectSpeaker(
                      e.target.value === "manager" ? "manager" : "client",
                    )
                  }
                  style={{ flex: "0 0 140px" }}
                >
                  <option value="client">Speaker: Client</option>
                  <option value="manager">Speaker: Manager</option>
                </select>
                <input
                  value={injectText}
                  onChange={(e) => setInjectText(e.target.value)}
                  placeholder="Simulate spoken phrase in active dialogue..."
                />
                <button className="btn ghost small" type="submit" disabled={simBusy}>
                  {simBusy ? "Streaming..." : "Inject speech"}
                </button>
              </form>
            )}

            <div className="transcript" aria-live="polite">
              {activeCall.transcripts.length === 0 ? (
                <p className="empty">
                  {activeCall.status === "ringing"
                    ? "Call is ringing — click Answer to open the bidirectional Opus WebRTC stream."
                    : "WebRTC Opus audio connected. Listening to both client and manager speech via VAD + Whisper..."}
                </p>
              ) : (
                activeCall.transcripts.map((entry) => {
                  const isMgr = entry.speaker === "manager";
                  return (
                    <div
                      key={entry.id}
                      className={`transcript-entry ${isMgr ? "manager" : "client"}`}
                    >
                      <span className="speaker">
                        {isMgr ? "Manager" : activeCall.client_name}
                      </span>
                      <span className="text">{entry.text}</span>
                      <span className="transcript-time">
                        {formatCallTime(entry.ts)}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div className="call-sim-box">
            <div className="spec-label">
              Live E2E Test · Trigger a simulated incoming WhatsApp call
            </div>
            <form
              className="call-sim-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setSimBusy(true);
                try {
                  await onSimulateCall(simPhone, simText);
                } finally {
                  setSimBusy(false);
                }
              }}
            >
              <select
                value={simPhone}
                onChange={(e) => setSimPhone(e.target.value)}
              >
                {clients.map((c) => (
                  <option key={c.client_id} value={c.phone_number}>
                    {c.client_name} ({c.phone_number})
                  </option>
                ))}
                {!clients.length && (
                  <option value="33745746025">33745746025</option>
                )}
              </select>
              <input
                value={simText}
                onChange={(e) => setSimText(e.target.value)}
                placeholder="Spoken customer order in French..."
              />
              <button className="btn primary" type="submit" disabled={simBusy}>
                {simBusy ? "Ringing..." : "Simulate incoming call"}
              </button>
            </form>
          </div>
        )}
      </div>

      <div className="call-history-section">
        <div className="panel-head">
          <div>
            <h3>Call history &amp; full transcripts</h3>
            <p className="panel-note muted">
              Browse past calls, inspect bidirectional Client + Manager dialogue, and open orders extracted from each conversation.
            </p>
          </div>
          <span className="pill">{recentCalls.length} recorded</span>
        </div>

        {recentCalls.length === 0 ? (
          <p className="empty">No call history recorded yet.</p>
        ) : (
          <div className="call-history-grid">
            <div className="call-history-sidebar">
              {recentCalls.map((c) => {
                const isSelected = c.call_id === effectiveSelectedId;
                const linkedCount = c.linked_commands?.length ?? (c.command_id ? 1 : 0);
                return (
                  <button
                    key={c.call_id}
                    type="button"
                    className={`call-history-item${isSelected ? " selected" : ""}`}
                    onClick={() => onSelectCall(c.call_id)}
                  >
                    <div className="call-history-item-top">
                      <strong>{c.client_name || c.phone_number}</strong>
                      <span className={`pill ${callStatusTone(c.status)}`}>
                        {c.status}
                      </span>
                    </div>
                    <div className="call-history-item-meta">
                      <span className="mono">{c.call_id}</span>
                      <span>{formatCallTime(c.started_at)}</span>
                    </div>
                    <div className="call-history-item-meta">
                      <span>{c.transcripts.length} segment(s)</span>
                      {linkedCount > 0 && (
                        <span className="pill ok">{linkedCount} order(s)</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="call-history-detail">
              {historyDetail ? (
                <>
                  <div className="call-detail-header">
                    <div>
                      <h4>
                        {historyDetail.client_name || historyDetail.phone_number}{" "}
                        <span className="mono muted" style={{ fontSize: 13 }}>
                          · {historyDetail.phone_number}
                        </span>
                      </h4>
                      <p className="muted" style={{ fontSize: 12.5 }}>
                        Call <span className="mono">{historyDetail.call_id}</span> · Mode{" "}
                        <span className="mono">{historyDetail.mode}</span> · Started{" "}
                        {formatCallTime(historyDetail.started_at)}
                        {historyDetail.ended_at
                          ? ` · Ended ${formatCallTime(historyDetail.ended_at)}`
                          : ""}
                        {historyLoading ? " · Refreshing..." : ""}
                      </p>
                    </div>
                    <span className={`pill ${callStatusTone(historyDetail.status)}`}>
                      {historyDetail.status}
                    </span>
                  </div>

                  <div className="spec-block">
                    <div className="spec-label">Conversation transcript (Client &amp; Manager)</div>
                    <div className="transcript compact-transcript">
                      {historyDetail.transcripts.length === 0 ? (
                        <p className="empty">No speech segments captured during this call.</p>
                      ) : (
                        historyDetail.transcripts.map((entry) => {
                          const isMgr = entry.speaker === "manager";
                          return (
                            <div
                              key={entry.id}
                              className={`transcript-entry ${isMgr ? "manager" : "client"}`}
                            >
                              <span className="speaker">
                                {isMgr ? "Manager" : historyDetail.client_name || "Client"}
                              </span>
                              <span className="text">{entry.text}</span>
                              <span className="transcript-time">
                                {formatCallTime(entry.ts)}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="spec-block">
                    <div className="spec-label">Orders linked to this call</div>
                    {historyDetail.linked_commands && historyDetail.linked_commands.length > 0 ? (
                      <div className="linked-commands-list">
                        {historyDetail.linked_commands.map((cmd) => (
                          <div
                            key={cmd.command_id}
                            className="linked-command-card"
                            onClick={() => onInspectCommand(cmd.command_id)}
                          >
                            <div className="linked-command-main">
                              <span className="mono">{cmd.command_id}</span>
                              <strong>
                                {cmd.quantity} × {cmd.product_name || cmd.product_id}
                              </strong>
                              <span className="muted">{cmd.summary}</span>
                            </div>
                            <div className="row-actions">
                              <span className={`pill ${cmd.status === "processed" ? "ok" : cmd.status === "rejected" || cmd.status === "cancelled" ? "bad" : "warn"}`}>
                                {cmd.status || "new"}
                              </span>
                              <span className="btn ghost small">Inspect</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="empty">No order extracted from this call.</p>
                    )}
                  </div>
                </>
              ) : (
                <p className="empty">Select a call on the left to inspect its full dialogue.</p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="call-controls call-fallback-box">
        <div className="panel-head">
          <div>
            <h3>Browser mic fallback (browser_webrtc)</h3>
            <p className="muted">
              Standalone browser microphone loop over WebSocket when testing without WhatsApp.
            </p>
          </div>
          <span className={`status-pill${connected ? " live" : ""}`}>
            {connected ? `Live - ${callId}` : "Offline"}
          </span>
        </div>
        <div className="call-buttons">
          {connected ? (
            <button className="btn reject" type="button" onClick={stopCall}>End fallback call</button>
          ) : (
            <button className="btn ghost" type="button" onClick={startCall} disabled={busy}>
              {busy ? "Starting..." : "Start fallback mic"}
            </button>
          )}
        </div>
        {error && <p className="error-text">{error}</p>}
        {entries.length > 0 && (
          <div className="transcript" aria-live="polite" style={{ marginTop: 12 }}>
            {entries.map((entry) => (
              <div key={entry.id} className={`transcript-entry ${entry.speaker}`}>
                <span className="speaker">{entry.speaker}</span>
                <span className="text">{entry.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
