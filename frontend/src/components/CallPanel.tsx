import { useEffect, useRef, useState } from "react";
import { api, callSocketUrl } from "../api";

interface TranscriptEntry {
  id: number;
  speaker: "system" | "assistant";
  text: string;
}

export default function CallPanel() {
  const [callId, setCallId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
        <h2>Live call</h2>
        <p className="muted">Stream microphone audio to the backend and read the live transcript.</p>
        <div className="call-buttons">
          {connected ? (
            <button className="button reject" type="button" onClick={stopCall}>End call</button>
          ) : (
            <button className="button primary" type="button" onClick={startCall} disabled={busy}>
              {busy ? "Starting..." : "Start call"}
            </button>
          )}
          <span className={`status-pill${connected ? " live" : ""}`}>
            {connected ? `Live${callId ? ` - ${callId}` : ""}` : "Offline"}
          </span>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>

      <div className="transcript" aria-live="polite">
        {entries.length === 0 && (
          <p className="empty">No transcript yet. Start a call to begin.</p>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className={`transcript-entry ${entry.speaker}`}>
            <span className="speaker">{entry.speaker}</span>
            <span className="text">{entry.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
