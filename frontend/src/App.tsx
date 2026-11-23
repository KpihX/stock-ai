import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { api, clearToken, getToken, streamUrl } from "./api";
import type {
  CallConfig,
  ClientAccount,
  ClientDetail,
  Command,
  CommandDetail,
  IncomingCallState,
  ManagerAccount,
  PipelineLogItem,
  Product,
  WaStatus,
} from "./types";
import Login from "./components/Login";
import CallPanel from "./components/CallPanel";
import BrandLogo from "./components/BrandLogo";

type PageId =
  | "dashboard"
  | "commands"
  | "products"
  | "clients"
  | "pipeline"
  | "call"
  | "settings";

interface GraphNodeDef {
  id: string;
  badge: string;
  title: string;
  stage: string;
  x: number;
  y: number;
  hasIn: boolean;
  hasOut: boolean;
  role: string;
  schema: string;
  example: Record<string, unknown>;
}

const THEME_KEY = "stockline_theme";
const POS_KEY = "stockline_n8n_positions_v2";

const GRAPH_NODES: GraphNodeDef[] = [
  {
    id: "channel.text",
    badge: "WA Text",
    title: "WhatsApp Text",
    stage: "1 · Trigger",
    x: 28,
    y: 28,
    hasIn: false,
    hasOut: true,
    role: "Captures inbound WhatsApp 1:1 text messages via Baileys messages.upsert, resolves @lid to E.164 phone digits, and deduplicates by message.key.id.",
    schema: `Signal {
  evenement_id: string
  capture_le: ISO8601 datetime
  canal: "whatsapp"
  actor_ref: E.164 phone
  modality: "text"
  texte: string
  cNumber: E.164 phone
}`,
    example: {
      evenement_id: "3EB02B7E50930D8C964A0E",
      canal: "whatsapp",
      actor_ref: "33745717350",
      modality: "text",
      texte: "Bonjour, je veux 3 pains de campagne pour demain",
    },
  },
  {
    id: "channel.voice",
    badge: "WA Voice",
    title: "Voice Note (.ogg)",
    stage: "1 · Trigger",
    x: 28,
    y: 162,
    hasIn: false,
    hasOut: true,
    role: "Downloads inbound WhatsApp Opus voice notes via Baileys downloadMediaMessage into /tmp/wa_media_<id>.ogg and forwards media_path to the STT node.",
    schema: `Signal {
  evenement_id: string
  modality: "audio"
  media_path: "/tmp/wa_media_<id>.ogg"
  cNumber: E.164 phone
}`,
    example: {
      evenement_id: "3EB0F6CE810E05D9E811E9",
      modality: "audio",
      media_path: "/tmp/wa_media_3EB0F6CE810E05D9E811E9.ogg",
      cNumber: "33745746025",
    },
  },
  {
    id: "channel.image",
    badge: "WA Image",
    title: "Order Image (.png)",
    stage: "1 · Trigger",
    x: 28,
    y: 296,
    hasIn: false,
    hasOut: true,
    role: "Downloads inbound WhatsApp purchase-order photos via downloadMediaMessage into /tmp/wa_media_<id>.png and forwards media_path + caption to Tesseract OCR.",
    schema: `Signal {
  evenement_id: string
  modality: "image"
  media_path: "/tmp/wa_media_<id>.png"
  texte: caption | "[image]"
  cNumber: E.164 phone
}`,
    example: {
      evenement_id: "evt_yohann_ocr_clean_2",
      modality: "image",
      media_path: "/tmp/wa_media_yohann_ocr.png",
      cNumber: "33745746025",
    },
  },
  {
    id: "channel.call",
    badge: "Live Call",
    title: "CallHandler WS",
    stage: "1 · Trigger",
    x: 28,
    y: 430,
    hasIn: false,
    hasOut: true,
    role: "Streams live call audio chunks over WebSocket /ws/call/{call_id} into 16 kHz WAV buffers for real-time Whisper transcription.",
    schema: `WebSocketFrame {
  type: "audio"
  call_id: string
  data: base64_pcm_wav
}`,
    example: {
      type: "audio",
      call_id: "a4f90c12e81b",
      chunk_wav: "/tmp/call_a4f90c12e81b_0.wav",
    },
  },
  {
    id: "stt.whisper",
    badge: "NIM / Local STT",
    title: "Speech-to-Text",
    stage: "2 · Extraction",
    x: 310,
    y: 150,
    hasIn: true,
    hasOut: true,
    role: "Extensible STT brick (config.jsonc selection.stt): NVIDIA NIM Whisper Large v3 / Parakeet Multilingual (<1s) with local whisper-cli fallback.",
    schema: `STTOutput {
  text: string
  provider: "nvidia_whisper" | "nvidia_parakeet" | "whisper"
  model: string
  elapsed_ms: number
}`,
    example: {
      text: "J'aimerais aussi avoir 10 kg de tomates grappes, s'il vous plaît.",
      provider: "nvidia_whisper",
      model: "openai/whisper-large-v3",
      elapsed_ms: 820,
    },
  },
  {
    id: "ocr.tesseract",
    badge: "NIM VL / OCR",
    title: "Vision / OCR",
    stage: "2 · Extraction",
    x: 310,
    y: 304,
    hasIn: true,
    hasOut: true,
    role: "Extensible OCR brick (config.jsonc selection.ocr): NVIDIA Nemotron 3.5 Super VL 120B (handwritten + printed notes) with local Tesseract fallback.",
    schema: `OCROutput {
  text: string
  ocr_raw: string
  provider: "nemotron_vl" | "tesseract"
  model: string
  elapsed_ms: number
}`,
    example: {
      text: "4 kg tomates grappe, 3 pains de campagne pour mardi soir",
      provider: "nemotron_vl",
      model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
      elapsed_ms: 1120,
    },
  },
  {
    id: "cmd.handler",
    badge: "Allowlist Guard",
    title: "CommandHandler",
    stage: "2 · Guard",
    x: 310,
    y: 448,
    hasIn: true,
    hasOut: true,
    role: "Enforces strict phone allowlist against PostgreSQL table client and rejects unknown numbers or duplicate evenement_id before any LLM call.",
    schema: `GuardDecision {
  phone_number: E.164 string
  allowed: boolean
  reason?: "unknown_client" | "duplicate"
}`,
    example: {
      phone_number: "33745746025",
      allowed: false,
      reason: "unknown_client",
    },
  },
  {
    id: "data.enriched",
    badge: "DB Context",
    title: "EnrichedData + Catalogue",
    stage: "3 · Context",
    x: 605,
    y: 220,
    hasIn: true,
    hasOut: true,
    role: "Joins the verified client profile, last_order_lines ('comme la dernière fois'), usual_lines ('comme d habitude'), open_commands (modifiable/cancellable) and the full product catalogue.",
    schema: `EnrichedData {
  client_id: string
  is_new_client: boolean
  client_stats: { order_count, last_order_lines, usual_lines }
  open_commands: CommandSummary[]
  products: Product[]
  signal: Signal
}`,
    example: {
      client_id: "CLI-0045",
      is_new_client: false,
      products_in_context: 3,
      open_commands_count: 2,
    },
  },
  {
    id: "llm.nemotron",
    badge: "AsyncOpenAI",
    title: "Nemotron 550B",
    stage: "3 · Agent AI",
    x: 895,
    y: 220,
    hasIn: true,
    hasOut: true,
    role: "Runs non-blocking AsyncOpenAI tool-calling loop (lookup_products, lookup_client_stats, lookup_commands) to classify intent (create | modify | cancel) and resolve phonetic STT/OCR items.",
    schema: `LLMCall {
  model: "nvidia/nemotron-3-ultra-550b-a55b"
  tools: ["lookup_products", "lookup_client_stats", "lookup_commands"]
  temperature: 0
  max_tokens: 4000
}`,
    example: {
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      turn: 1,
      action: "modify",
      target_command_id: "C-922a0a99",
    },
  },
  {
    id: "data.normalized",
    badge: "Intent Schema",
    title: "NormalizedInput",
    stage: "4 · Normalization",
    x: 1180,
    y: 115,
    hasIn: true,
    hasOut: true,
    role: "Validates the LLM JSON output: action ('create' | 'modify' | 'cancel'), target_command_id, French summary sentence, and typed order_lines with verified product_id and unit price.",
    schema: `NormalizedInput {
  action: "create" | "modify" | "cancel"
  target_command_id: string | null
  summary: string
  order_lines: [{ product_id, quantity, price, delivery_date }]
}`,
    example: {
      action: "modify",
      target_command_id: "C-922a0a99",
      summary:
        "Modification de la commande C-922a0a99 : 15 kg de Tomates grappe à 2,45 €/kg pour le 24 novembre 2026.",
      order_lines: [
        {
          product_id: "ART-TOM-GR-01",
          quantity: 15,
          price: 2.45,
          delivery_date: "2026-11-24",
        },
      ],
    },
  },
  {
    id: "db.command",
    badge: "PostgreSQL 17",
    title: "client.db · Command",
    stage: "4 · Persistence",
    x: 1180,
    y: 265,
    hasIn: true,
    hasOut: true,
    role: "Inserts new orders, replaces modified order groups in-place (refunding stock if previously approved), or marks orders cancelled in PostgreSQL.",
    schema: `CommandRow {
  command_id: "C-xxxxxxxx"
  client_id: string
  product_id: string
  quantity: numeric(12,3)
  price: numeric(12,2)
  status: "new" | "processed" | "rejected" | "cancelled"
}`,
    example: {
      command_id: "C-922a0a99",
      client_id: "CLI-0045",
      product_id: "ART-TOM-GR-01",
      quantity: 15,
      status: "new",
    },
  },
  {
    id: "decision.hitl",
    badge: "HITL & WA Reply",
    title: "Approve / Reject + WA",
    stage: "5 · Supervision",
    x: 1180,
    y: 418,
    hasIn: true,
    hasOut: false,
    role: "Sends automatic WhatsApp intake/modification/cancellation acks and processes manager Approve/Reject decisions with optional comment and automatic stock decrementation.",
    schema: `DecisionOutcome {
  command_id: string
  status: "processed" | "rejected"
  comment: string
  decided_by: string
  new_stock: number
  wa_sent: boolean
}`,
    example: {
      command_id: "C-922a0a99",
      status: "processed",
      comment: "Modification 15 kg approuvée",
      new_stock: 35,
      wa_sent: true,
    },
  },
];

const GRAPH_EDGES: Array<[string, string]> = [
  ["channel.text", "cmd.handler"],
  ["channel.text", "data.enriched"],
  ["channel.voice", "stt.whisper"],
  ["channel.image", "ocr.tesseract"],
  ["channel.call", "stt.whisper"],
  ["stt.whisper", "data.enriched"],
  ["ocr.tesseract", "data.enriched"],
  ["cmd.handler", "data.enriched"],
  ["data.enriched", "llm.nemotron"],
  ["llm.nemotron", "data.normalized"],
  ["data.normalized", "db.command"],
  ["db.command", "decision.hitl"],
];

function money(val: unknown): string {
  const n = Number(val ?? 0);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function qty(val: unknown): string {
  const n = Number(val ?? 0);
  return Number.isFinite(n) ? String(Number(n.toFixed(3))) : "0";
}

function dateLabel(val?: string | null): string {
  if (!val) return "—";
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? String(val) : d.toLocaleString();
}

function statusPillClass(status?: string): string {
  const s = String(status || "new").toLowerCase();
  if (s === "processed" || s === "ok" || s === "sent" || s === "transcribed") return "ok";
  if (s === "rejected" || s === "cancelled" || s === "error") return "bad";
  return "warn";
}

function statusLabel(status?: string): string {
  const s = String(status || "new").toLowerCase();
  return s === "processed" ? "approved" : s;
}

function sourceChannelLabel(channel?: string): string {
  switch (String(channel || "").toLowerCase()) {
    case "whatsapp_call":
      return "WhatsApp Call";
    case "simulated_call":
      return "Simulated Call";
    case "browser_call":
      return "Browser Call";
    case "whatsapp_voice":
      return "WhatsApp Voice";
    case "whatsapp_image":
      return "WhatsApp Image";
    case "whatsapp_text":
      return "WhatsApp Text";
    case "manual":
      return "Manual Entry";
    default:
      return "WhatsApp";
  }
}

function sourceChannelTone(channel?: string): string {
  const ch = String(channel || "").toLowerCase();
  if (ch.includes("call")) return "info";
  if (ch === "whatsapp_voice" || ch === "whatsapp_image") return "warn";
  if (ch === "manual") return "";
  return "ok";
}

function loadPositions(): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(POS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, { x: number; y: number }>) : {};
  } catch {
    return {};
  }
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => getToken());

  if (!token) {
    return <Login onLogin={setToken} />;
  }

  return (
    <Workspace
      onLogout={() => {
        clearToken();
        setToken(null);
      }}
    />
  );
}

function Workspace({ onLogout }: { onLogout: () => void }) {
  const [theme, setThemeState] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  const [page, setPage] = useState<PageId>("dashboard");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [username, setUsername] = useState("admin");
  const [role, setRole] = useState<"admin" | "manager">("admin");

  const [commands, setCommands] = useState<Command[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [clients, setClients] = useState<ClientAccount[]>([]);
  const [managers, setManagers] = useState<ManagerAccount[]>([]);
  const [logs, setLogs] = useState<PipelineLogItem[]>([]);
  const [wa, setWa] = useState<WaStatus>({
    status: "checking",
    phone: "",
    qr_ready: false,
  });
  const [qrDataUrl, setQrDataUrl] = useState("");

  const [commandSearch, setCommandSearch] = useState("");
  const [commandStatus, setCommandStatus] = useState("all");
  const [commandClientType, setCommandClientType] = useState("all");
  const [commentsById, setCommentsById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [clientDetail, setClientDetail] = useState<ClientDetail | null>(null);

  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [prodForm, setProdForm] = useState({
    product_id: "",
    product_name: "",
    price: "",
    stock: "",
  });

  const [editingClientId, setEditingClientId] = useState<string | null>(null);
  const [cliForm, setCliForm] = useState({
    client_id: "",
    phone_number: "",
    client_name: "",
  });

  const [editingManager, setEditingManager] = useState<string | null>(null);
  const [mgrForm, setMgrForm] = useState({ username: "", password: "" });

  const [editingCommandId, setEditingCommandId] = useState<string | null>(null);
  const [cmdEditForm, setCmdEditForm] = useState({
    quantity: "",
    status: "new",
    summary: "",
  });
  const [newCmdOpen, setNewCmdOpen] = useState(false);
  const [newCmdForm, setNewCmdForm] = useState({
    client_id: "",
    product_id: "",
    quantity: "1",
    summary: "",
  });

  const [selectedNodeId, setSelectedNodeId] = useState("llm.nemotron");
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [filterByNode, setFilterByNode] = useState(false);
  const [nodePositions, setNodePositions] =
    useState<Record<string, { x: number; y: number }>>(loadPositions);
  const [zoom, setZoom] = useState(0.86);
  const [pan, setPan] = useState({ x: 14, y: 10 });
  const [panning, setPanning] = useState(false);
  const [sseState, setSseState] = useState<"open" | "connecting" | "closed">(
    "connecting",
  );
  const [toastMsg, setToastMsg] = useState<{ text: string; bad: boolean } | null>(
    null,
  );
  const [topBanner, setTopBanner] = useState<{
    id: string;
    badge: string;
    tone: "warn" | "ok" | "bad";
    title: string;
    description: string;
    commandId?: string;
  } | null>(null);
  const [flashCommandId, setFlashCommandId] = useState<string | null>(null);
  const knownSigRef = useRef<string>("");

  const [activeCall, setActiveCall] = useState<IncomingCallState | null>(null);
  const [recentCalls, setRecentCalls] = useState<IncomingCallState[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [webrtcState, setWebrtcState] = useState<string>("idle");
  const [callBusy, setCallBusy] = useState(false);
  const [waActionBusy, setWaActionBusy] = useState(false);
  const [selectedCommandDetail, setSelectedCommandDetail] =
    useState<CommandDetail | null>(null);
  const [commandDetailLoading, setCommandDetailLoading] = useState(false);
  const callConfigRef = useRef<CallConfig | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const silentCtxRef = useRef<AudioContext | null>(null);

  const dragRef = useRef<{
    mode: "node" | "pan";
    nodeId?: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  const showToast = useCallback((text: string, bad = false) => {
    setToastMsg({ text, bad });
  }, []);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 3600);
    return () => clearTimeout(t);
  }, [toastMsg]);

  useEffect(() => {
    if (!topBanner) return;
    const t = setTimeout(() => setTopBanner(null), 9000);
    return () => clearTimeout(t);
  }, [topBanner]);

  useEffect(() => {
    if (!flashCommandId) return;
    const t = setTimeout(() => setFlashCommandId(null), 3000);
    return () => clearTimeout(t);
  }, [flashCommandId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const refreshWa = useCallback(
    async (currentRole = role) => {
      if (currentRole !== "admin") return;
      try {
        const status = await api.waStatus();
        setWa(status);
        if (status.status !== "connected" && status.qr_ready) {
          const q = await api.waQr();
          if (q?.qr) setQrDataUrl(q.qr);
        } else {
          setQrDataUrl("");
        }
      } catch {
        setWa({ status: "unavailable", phone: "", qr_ready: false });
      }
    },
    [role],
  );

  const loadAll = useCallback(async () => {
    try {
      const me = await api.me();
      const userRole = me.role === "admin" ? "admin" : "manager";
      setUsername(me.username);
      setRole(userRole);
      const [cmds, prods, clis, pipe, callState, callCfg] = await Promise.all([
        api.getCommands(),
        api.getProducts(),
        api.getClients(),
        api.getPipelineLogs(120),
        api.getActiveCalls().catch(() => ({ items: [], recent: [] })),
        api.getCallConfig().catch(() => null),
      ]);
      setCommands(cmds);
      setProducts(prods);
      setClients(clis);
      setLogs(pipe);
      if (callCfg) callConfigRef.current = callCfg;
      const callHistory = await api.getCallHistory(50).catch(() => null);
      setRecentCalls(callHistory?.items?.length ? callHistory.items : callState.recent || []);
      if (callState.items?.length) {
        setActiveCall((curr) => curr || callState.items[0]);
      }
      knownSigRef.current = cmds
        .map((c) => `${c.command_id}:${c.status}:${c.quantity}:${c.summary}`)
        .join("|");
      if (userRole === "admin") {
        const [mgrs] = await Promise.all([
          api.getManagers(),
          refreshWa("admin"),
        ]);
        setManagers(mgrs);
      } else {
        setWa({ status: "active", phone: "", qr_ready: false });
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load data", true);
    }
  }, [refreshWa, showToast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const source = new EventSource(streamUrl());
    source.onopen = () => setSseState("open");
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setSseState("connecting");
    };
    source.onmessage = (ev) => {
      setSseState("open");
      try {
        const event = JSON.parse(ev.data) as Record<string, unknown>;
        if (event.type === "stream.connected") {
          setSseState("open");
          return;
        }
        const item: PipelineLogItem = {
          log_id: Number(event.log_id || Date.now()),
          created_at: String(
            event.created_at || event.ts || new Date().toISOString(),
          ),
          event_type: String(event.type || "event"),
          node_id: String(event.node || ""),
          client_id: String(event.client_id || ""),
          phone_number: String(event.phone_number || ""),
          command_id: String(event.command_id || ""),
          actor: String(event.actor || ""),
          status: String(event.status || "ok"),
          message: String(event.message || ""),
          payload: event,
        };
        setLogs((prev) =>
          [item, ...prev.filter((x) => x.log_id !== item.log_id)].slice(0, 150),
        );
        if (item.node_id) {
          setSelectedNodeId(item.node_id);
        }
        if (item.event_type === "call.incoming") {
          const incoming: IncomingCallState = {
            call_id: String(event.call_id || ""),
            phone_number: String(event.phone_number || ""),
            client_id: String(event.client_id || ""),
            client_name: String(event.client_name || event.phone_number || "Caller"),
            known_client: Boolean(event.known_client),
            status: "ringing",
            mode: String(event.mode || "baileys_voip"),
            started_at: item.created_at,
            muted: false,
            committed: false,
            transcripts: [],
          };
          setActiveCall(incoming);
          setWebrtcState("ringing");
          showToast(`Incoming WhatsApp call from ${incoming.client_name}`);
        }
        if (item.event_type === "call.state") {
          const cid = String(event.call_id || "");
          const st = String(event.status || "active") as IncomingCallState["status"];
          setActiveCall((curr) =>
            curr && curr.call_id === cid ? { ...curr, status: st } : curr,
          );
        }
        if (item.event_type === "call.transcript") {
          const cid = String(event.call_id || "");
          const txt = String(event.text || "").trim();
          const speaker =
            String(event.speaker || "client").toLowerCase() === "manager"
              ? "manager"
              : "client";
          if (txt) {
            setActiveCall((curr) =>
              curr && curr.call_id === cid
                ? {
                    ...curr,
                    transcripts: [
                      ...curr.transcripts,
                      {
                        id: String(item.log_id),
                        speaker,
                        text: txt,
                        duration_ms: Number(event.duration_ms || 0),
                        ts: item.created_at,
                      },
                    ],
                  }
                : curr,
            );
          }
        }
        if (item.event_type === "call.ended") {
          const cid = String(event.call_id || "");
          setActiveCall((curr) => (curr && curr.call_id === cid ? null : curr));
          void api
            .getActiveCalls()
            .then((res) => setRecentCalls(res.recent || []))
            .catch(() => {});
          if (pcRef.current) {
            try {
              pcRef.current.close();
            } catch {}
            pcRef.current = null;
          }
          localStreamRef.current?.getTracks().forEach((t) => t.stop());
          localStreamRef.current = null;
          if (silentCtxRef.current) {
            void silentCtxRef.current.close().catch(() => {});
            silentCtxRef.current = null;
          }
          setWebrtcState("idle");
        }
        if (item.event_type === "signal.received") {
          setTopBanner({
            id: String(item.log_id),
            badge: "Incoming Signal",
            tone: "warn",
            title: `Signal received from ${item.phone_number || "WhatsApp"}`,
            description: item.message,
          });
        }
        if (
          [
            "command.created",
            "command.modified",
            "command.cancelled",
            "command.decided",
            "command.deleted",
          ].includes(item.event_type)
        ) {
          void Promise.all([
            api.getCommands(),
            api.getClients(),
            api.getProducts(),
          ]).then(([cmds, clis, prods]) => {
            setCommands(cmds);
            setClients(clis);
            setProducts(prods);
            knownSigRef.current = cmds
              .map(
                (c) => `${c.command_id}:${c.status}:${c.quantity}:${c.summary}`,
              )
              .join("|");
            const targetCmd =
              cmds.find(
                (c) =>
                  c.command_id === item.command_id ||
                  c.command_id.startsWith(`${item.command_id}-`),
              ) || cmds[0];
            if (
              targetCmd &&
              item.event_type !== "command.decided" &&
              item.event_type !== "command.deleted"
            ) {
              const cid = targetCmd.command_id || targetCmd.id || "";
              setFlashCommandId(cid);
              const badge =
                item.event_type === "command.modified"
                  ? "Order Updated"
                  : item.event_type === "command.cancelled"
                    ? "Order Cancelled"
                    : "New Order";
              const tone =
                item.event_type === "command.cancelled"
                  ? "bad"
                  : item.event_type === "command.modified"
                    ? "warn"
                    : "ok";
              setTopBanner({
                id: `${cid}-${Date.now()}`,
                badge,
                tone,
                title: `${targetCmd.client_name || targetCmd.client_id} · ${cid}`,
                description:
                  targetCmd.summary ||
                  `${qty(targetCmd.quantity)} × ${targetCmd.product_name || targetCmd.product_id}`,
                commandId: cid,
              });
            }
          });
        }
        if (item.event_type === "product.updated") {
          void api.getProducts().then(setProducts).catch(() => {});
        }
        if (item.event_type === "client.updated") {
          void api.getClients().then(setClients).catch(() => {});
        }
        if (item.event_type === "manager.updated" && role === "admin") {
          void api.getManagers().then(setManagers).catch(() => {});
        }
        if (item.event_type === "whatsapp.updated") {
          void refreshWa(role);
        }
        if (
          [
            "pipeline.error",
            "llm.error",
            "stt.error",
            "ocr.error",
            "call.error",
            "call.commit_error",
          ].includes(item.event_type)
        ) {
          const msg = item.message || `Pipeline error on ${item.node_id || item.event_type}`;
          showToast(msg, true);
          setTopBanner({
            id: `${item.log_id}-${Date.now()}`,
            badge: "Pipeline Error",
            tone: "bad",
            title: `${item.node_id || item.event_type}`,
            description: msg,
          });
        } else if (
          item.event_type === "pipeline.warning" ||
          item.event_type === "command.rejected" ||
          (item.event_type === "whatsapp.ack" &&
            (item.status === "warn" || item.status === "error"))
        ) {
          showToast(item.message || "Pipeline warning", true);
        }
      } catch {
        // ignore malformed event
      }
    };
    return () => source.close();
  }, [refreshWa, role, showToast]);

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const [cmds, pipe, clis, prods, callState] = await Promise.all([
          api.getCommands(),
          api.getPipelineLogs(120),
          api.getClients(),
          api.getProducts(),
          api.getActiveCalls().catch(() => null),
        ]);
        setLogs(pipe);
        setClients(clis);
        setProducts(prods);
        if (role === "admin") {
          void api.getManagers().then(setManagers).catch(() => {});
        }
        if (callState) {
          setRecentCalls(callState.recent || []);
          const liveCall = callState.items?.[0] || null;
          setActiveCall((curr) => {
            if (!liveCall) {
              return curr && (curr.status === "ringing" || curr.status === "active")
                ? null
                : curr;
            }
            if (!curr || curr.call_id !== liveCall.call_id) return liveCall;
            return {
              ...liveCall,
              transcripts:
                liveCall.transcripts.length >= curr.transcripts.length
                  ? liveCall.transcripts
                  : curr.transcripts,
            };
          });
        }
        const newSig = cmds
          .map((c) => `${c.command_id}:${c.status}:${c.quantity}:${c.summary}`)
          .join("|");
        if (knownSigRef.current && newSig !== knownSigRef.current) {
          const prevIds = new Set(
            knownSigRef.current
              .split("|")
              .map((s) => s.split(":")[0])
              .filter(Boolean),
          );
          const added = cmds.find((c) => !prevIds.has(c.command_id));
          const latest = added || cmds[0];
          if (latest) {
            const cid = latest.command_id || latest.id || "";
            setFlashCommandId(cid);
            setTopBanner((curr) =>
              curr?.commandId === cid
                ? curr
                : {
                    id: `${cid}-${Date.now()}`,
                    badge: added ? "New Order" : "Order Updated",
                    tone:
                      latest.status === "cancelled"
                        ? "bad"
                        : added
                          ? "ok"
                          : "warn",
                    title: `${latest.client_name || latest.client_id} · ${cid}`,
                    description:
                      latest.summary ||
                      `${qty(latest.quantity)} × ${latest.product_name || latest.product_id}`,
                    commandId: cid,
                  },
            );
          }
          const [clis, prods] = await Promise.all([
            api.getClients(),
            api.getProducts(),
          ]);
          setClients(clis);
          setProducts(prods);
        }
        knownSigRef.current = newSig;
        setCommands(cmds);
      } catch {
        // silent background poll
      }
    }, 3000);
    return () => clearInterval(t);
  }, [role]);

  useEffect(() => {
    if (role !== "admin") return;
    const t = setInterval(() => void refreshWa("admin"), 6000);
    return () => clearInterval(t);
  }, [role, refreshWa]);

  const closeWebRtcPeer = useCallback(() => {
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (silentCtxRef.current) {
      void silentCtxRef.current.close().catch(() => {});
      silentCtxRef.current = null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    setWebrtcState("idle");
  }, []);

  useEffect(() => {
    return () => closeWebRtcPeer();
  }, [closeWebRtcPeer]);

  const answerCall = useCallback(
    async (callId: string) => {
      setCallBusy(true);
      try {
        closeWebRtcPeer();
        setWebrtcState("connecting");

        let stream: MediaStream;
        try {
          const micPromise = navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
              sampleRate: { ideal: 48000 },
            },
            video: false,
          });
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Microphone prompt timed out")), 4500),
          );
          stream = await Promise.race([micPromise, timeoutPromise]);
        } catch {
          // Graceful fallback when mic is missing or permission prompt is dismissed/timed out
          const ctx = new AudioContext();
          silentCtxRef.current = ctx;
          const dst = ctx.createMediaStreamDestination();
          stream = dst.stream;
        }
        localStreamRef.current = stream;

        const iceServers = callConfigRef.current?.ice_servers?.length
          ? callConfigRef.current.ice_servers
          : [{ urls: "stun:stun.l.google.com:19302" }];

        const pc = new RTCPeerConnection({ iceServers });
        pcRef.current = pc;

        for (const track of stream.getTracks()) {
          pc.addTrack(track, stream);
        }

        pc.ontrack = (ev) => {
          const remoteStream = new MediaStream([ev.track]);
          if (remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = remoteStream;
            void remoteAudioRef.current.play().catch(() => {});
          }
        };

        pc.onconnectionstatechange = () => {
          const st = pc.connectionState || "connecting";
          setWebrtcState(st);
          if (st === "failed" || st === "disconnected") {
            showToast(`WebRTC audio ${st} — check network/UDP or hang up`, true);
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === "complete") {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 2500);
          const onChange = () => {
            if (pc.iceGatheringState === "complete") {
              clearTimeout(timer);
              pc.removeEventListener("icegatheringstatechange", onChange);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", onChange);
        });

        const sdpOffer = pc.localDescription?.sdp || offer.sdp || "";
        const res = await api.acceptCall(callId, sdpOffer);
        await pc.setRemoteDescription({ type: "answer", sdp: res.sdp_answer });
        setActiveCall((curr) =>
          curr && curr.call_id === callId ? { ...curr, status: "active" } : curr,
        );
        setPage("call");
        showToast("WebRTC Opus call connected");
      } catch (err) {
        closeWebRtcPeer();
        showToast(
          err instanceof Error ? err.message : "Failed to answer call",
          true,
        );
      } finally {
        setCallBusy(false);
      }
    },
    [closeWebRtcPeer, showToast],
  );

  const rejectCall = useCallback(
    async (callId: string) => {
      setCallBusy(true);
      try {
        await api.rejectCall(callId);
        closeWebRtcPeer();
        setActiveCall(null);
        showToast("Call rejected");
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : "Failed to reject call",
          true,
        );
      } finally {
        setCallBusy(false);
      }
    },
    [closeWebRtcPeer, showToast],
  );

  const hangupCall = useCallback(
    async (callId: string) => {
      setCallBusy(true);
      try {
        await api.hangupCall(callId);
        closeWebRtcPeer();
        setActiveCall(null);
        showToast("Call ended");
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : "Failed to hang up",
          true,
        );
      } finally {
        setCallBusy(false);
      }
    },
    [closeWebRtcPeer, showToast],
  );

  const toggleCallMute = useCallback(
    async (callId: string, muted: boolean) => {
      localStreamRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = !muted;
      });
      setActiveCall((curr) =>
        curr && curr.call_id === callId ? { ...curr, muted } : curr,
      );
      try {
        await api.muteCall(callId, muted);
      } catch {
        // local track already muted
      }
    },
    [],
  );

  const commitCallOrder = useCallback(
    async (callId: string) => {
      try {
        await api.commitCall(callId);
        setActiveCall((curr) =>
          curr && curr.call_id === callId ? { ...curr, committed: true } : curr,
        );
        showToast("Order extraction triggered from live call transcript");
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : "Order extraction failed",
          true,
        );
      }
    },
    [showToast],
  );

  const simulateIncomingCall = useCallback(
    async (phone: string, text: string) => {
      try {
        const res = await api.simulateCall(phone, text);
        showToast(`Simulated WhatsApp call ${res.call_id} ringing`);
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : "Failed to simulate call",
          true,
        );
      }
    },
    [showToast],
  );

  const injectCallText = useCallback(
    async (
      callId: string,
      text: string,
      speaker: "client" | "manager" = "client",
    ) => {
      try {
        await api.injectCallText(callId, text, speaker);
        showToast(`Injected ${speaker} speech into active WebRTC call`);
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : "Failed to inject speech",
          true,
        );
      }
    },
    [showToast],
  );

  const openCommandDetail = useCallback(
    async (commandId: string) => {
      if (!commandId) return;
      setCommandDetailLoading(true);
      try {
        const detail = await api.getCommand(commandId);
        setSelectedCommandDetail(detail);
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : "Unable to load command detail",
          true,
        );
      } finally {
        setCommandDetailLoading(false);
      }
    },
    [showToast],
  );

  const openCallInDesk = useCallback((callId: string) => {
    setSelectedCommandDetail(null);
    setSelectedCallId(callId);
    setPage("call");
  }, []);

  useEffect(() => {
    if (
      role !== "admin" ||
      page !== "settings" ||
      (wa.status !== "connecting" && wa.status !== "qr_pending")
    ) {
      return;
    }
    const timer = setInterval(() => {
      void refreshWa("admin");
    }, 1500);
    return () => clearInterval(timer);
  }, [page, refreshWa, role, wa.status]);

  const openClientProfile = useCallback(
    async (clientId: string) => {
      setSelectedClientId(clientId);
      try {
        const detail = await api.getClientDetail(clientId);
        setClientDetail(detail);
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : "Unable to load client detail",
          true,
        );
      }
    },
    [showToast],
  );

  async function handleDecision(cmd: Command, approve: boolean) {
    const id = cmd.command_id || cmd.id || "";
    if (!id) return;
    setBusyId(id);
    try {
      const comment = (commentsById[id] || "").trim();
      const res = await api.approveCommand(id, approve, comment);
      const [cmds, clis, prods, pipe] = await Promise.all([
        api.getCommands(),
        api.getClients(),
        api.getProducts(),
        api.getPipelineLogs(120),
      ]);
      setCommands(cmds);
      setClients(clis);
      setProducts(prods);
      setLogs(pipe);
      if (selectedClientId) void openClientProfile(selectedClientId);
      showToast(
        `${approve ? "Approved" : "Rejected"}${res.wa_sent ? " · WhatsApp notification sent" : ""}`,
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Decision failed", true);
    } finally {
      setBusyId(null);
    }
  }

  async function submitProduct(e: FormEvent) {
    e.preventDefault();
    try {
      await api.saveProduct({
        product_id: prodForm.product_id.trim(),
        product_name: prodForm.product_name.trim(),
        price: Number(prodForm.price),
        stock: Number(prodForm.stock),
      });
      setEditingProductId(null);
      setProdForm({ product_id: "", product_name: "", price: "", stock: "" });
      setProducts(await api.getProducts());
      showToast("Product saved");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed", true);
    }
  }

  async function submitClient(e: FormEvent) {
    e.preventDefault();
    try {
      const cid = cliForm.client_id.trim();
      await api.saveClient({
        client_id: cid,
        phone_number: cliForm.phone_number.trim(),
        client_name: cliForm.client_name.trim(),
      });
      setEditingClientId(null);
      setCliForm({ client_id: "", phone_number: "", client_name: "" });
      setClients(await api.getClients());
      if (selectedClientId === cid) void openClientProfile(cid);
      showToast("Client saved");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed", true);
    }
  }

  async function submitNewCommand(e: FormEvent) {
    e.preventDefault();
    const clientId = newCmdForm.client_id || clients[0]?.client_id || "";
    const productId = newCmdForm.product_id || products[0]?.product_id || "";
    if (!clientId || !productId) {
      showToast("Add at least one client and one product first", true);
      return;
    }
    try {
      await api.createCommand({
        client_id: clientId,
        product_id: productId,
        quantity: Number(newCmdForm.quantity),
        summary: newCmdForm.summary.trim(),
      });
      setNewCmdOpen(false);
      setNewCmdForm({ client_id: "", product_id: "", quantity: "1", summary: "" });
      await loadAll();
      showToast("Command created");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Create failed", true);
    }
  }

  async function saveCommandEdit(commandId: string) {
    setBusyId(commandId);
    try {
      await api.updateCommand(commandId, {
        quantity: Number(cmdEditForm.quantity),
        status: cmdEditForm.status,
        summary: cmdEditForm.summary.trim(),
      });
      setEditingCommandId(null);
      await loadAll();
      showToast(`Updated ${commandId}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Update failed", true);
    } finally {
      setBusyId(null);
    }
  }

  async function deleteCommand(commandId: string) {
    setBusyId(commandId);
    try {
      await api.deleteCommand(commandId);
      if (editingCommandId === commandId) setEditingCommandId(null);
      await loadAll();
      showToast(`Deleted ${commandId}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Delete failed", true);
    } finally {
      setBusyId(null);
    }
  }

  async function submitManager(e: FormEvent) {
    e.preventDefault();
    try {
      if (editingManager) {
        await api.updateManager(
          editingManager,
          mgrForm.password ? { password: mgrForm.password } : {},
        );
      } else {
        await api.createManager({
          username: mgrForm.username.trim(),
          password: mgrForm.password,
        });
      }
      setEditingManager(null);
      setMgrForm({ username: "", password: "" });
      setManagers(await api.getManagers());
      showToast("Manager saved");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed", true);
    }
  }

  const filteredCommands = useMemo(() => {
    const q = commandSearch.trim().toLowerCase();
    return commands.filter((c) => {
      const st = String(c.status || "new").toLowerCase();
      const matchSt = commandStatus === "all" || st === commandStatus;
      const count = Number(c.client_order_count || 1);
      const matchType =
        commandClientType === "all" ||
        (commandClientType === "new" && count <= 1) ||
        (commandClientType === "returning" && count > 1);
      const hay = [
        c.command_id,
        c.client_name,
        c.client_phone,
        c.client_id,
        c.product_id,
        c.product_name,
        c.summary,
        c.decision_comment,
      ]
        .join(" ")
        .toLowerCase();
      return matchSt && matchType && (!q || hay.includes(q));
    });
  }, [commands, commandSearch, commandStatus, commandClientType]);

  const { nodePayloads, nodeCounts } = useMemo(() => {
    const payloads: Record<string, PipelineLogItem> = {};
    const counts: Record<string, number> = {};
    for (const item of [...logs].reverse()) {
      const nid = item.node_id;
      if (!nid) continue;
      payloads[nid] = item;
      counts[nid] = (counts[nid] || 0) + 1;
    }
    return { nodePayloads: payloads, nodeCounts: counts };
  }, [logs]);

  const getNodePos = useCallback(
    (def: GraphNodeDef) => {
      const saved = nodePositions[def.id];
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        return saved;
      }
      return { x: def.x, y: def.y };
    },
    [nodePositions],
  );

  function handleCanvasPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const nodeEl = target.closest("[data-graph-node]") as HTMLElement | null;
    if (nodeEl) {
      const nodeId = nodeEl.dataset.graphNode || "";
      const def = GRAPH_NODES.find((n) => n.id === nodeId);
      const pos = def ? getNodePos(def) : { x: 0, y: 0 };
      dragRef.current = {
        mode: "node",
        nodeId,
        startX: e.clientX,
        startY: e.clientY,
        origX: pos.x,
        origY: pos.y,
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      dragRef.current = {
        mode: "pan",
        startX: e.clientX,
        startY: e.clientY,
        origX: pan.x,
        origY: pan.y,
        moved: false,
      };
      setPanning(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }

  function handleCanvasPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
    if (d.mode === "node" && d.nodeId) {
      const nx = Math.max(8, Math.round(d.origX + dx / zoom));
      const ny = Math.max(8, Math.round(d.origY + dy / zoom));
      setNodePositions((prev) => {
        const next = { ...prev, [d.nodeId!]: { x: nx, y: ny } };
        localStorage.setItem(POS_KEY, JSON.stringify(next));
        return next;
      });
    } else if (d.mode === "pan") {
      setPan({ x: Math.round(d.origX + dx), y: Math.round(d.origY + dy) });
    }
  }

  function handleCanvasPointerUp() {
    const d = dragRef.current;
    if (d && d.mode === "node" && d.nodeId && !d.moved) {
      setSelectedNodeId(d.nodeId);
      setSelectedLogId(null);
    }
    dragRef.current = null;
    setPanning(false);
  }

  const selectedDef =
    GRAPH_NODES.find((n) => n.id === selectedNodeId) || GRAPH_NODES[0];
  const selectedLiveItem =
    (selectedLogId
      ? logs.find((l) => l.log_id === selectedLogId)
      : nodePayloads[selectedDef.id]) || null;
  const visibleEnumLogs = useMemo(
    () =>
      filterByNode
        ? logs.filter((l) => l.node_id === selectedDef.id)
        : logs,
    [logs, filterByNode, selectedDef.id],
  );

  const pendingOrders = commands.filter(
    (c) => String(c.status || "new").toLowerCase() === "new",
  ).length;
  const approvedOrders = commands.filter(
    (c) => String(c.status || "").toLowerCase() === "processed",
  ).length;
  const waLabel =
    wa.status === "connected"
      ? "Connected"
      : wa.status === "qr_pending"
        ? "Waiting scan"
        : wa.status === "connecting"
          ? "Connecting..."
          : wa.status === "checking"
            ? "Checking..."
            : wa.status === "disconnected"
              ? "Disconnected"
              : "WA Offline";

  const pageMeta: Record<PageId, [string, string]> = {
    dashboard: [
      "Dashboard",
      "Live orders, decision workflow and catalogue health.",
    ],
    commands: [
      "Commands",
      "Approve or reject orders with an optional WhatsApp reply to the client.",
    ],
    products: [
      "Products",
      "Catalogue pricing and available stock used by the ordering agent.",
    ],
    clients: [
      "Clients",
      "Registered WhatsApp buyers. Click any client to open their order history and statistics.",
    ],
    pipeline: [
      "Pipeline",
      "Interactive n8n-style execution graph from WhatsApp intake to Nemotron 550B and PostgreSQL.",
    ],
    call: [
      "Live call",
      "Stream voice order chunks over WebSocket for real-time transcription.",
    ],
    settings: [
      "Settings",
      "WhatsApp pairing and manager account administration.",
    ],
  };

  function renderCommandTable(items: Command[], compact = false) {
    if (!items.length) {
      return <p className="empty">No commands recorded yet.</p>;
    }
    return (
      <table className="responsive-table">
        <thead>
          <tr>
            <th>Command</th>
            <th>Client</th>
            <th>Product</th>
            <th>Qty</th>
            {!compact && <th>Unit (€)</th>}
            <th>Status</th>
            {!compact && <th>Received</th>}
            <th>Decision &amp; WhatsApp reply</th>
          </tr>
        </thead>
        <tbody>
          {items.map((cmd) => {
            const id = cmd.command_id || cmd.id || "";
            const st = String(cmd.status || "new").toLowerCase();
            const count = Number(cmd.client_order_count || 1);
            return (
              <tr
                key={id}
                className={`clickable-row${flashCommandId === id ? " row-flash" : ""}${selectedCommandDetail?.command.command_id === id ? " selected" : ""}`}
                onClick={() => void openCommandDetail(id)}
              >
                <td data-label="Command">
                  <div className="cmd-id-row">
                    <span className="mono">{id}</span>
                    <span className={`pill ${sourceChannelTone(cmd.source_channel)}`}>
                      {sourceChannelLabel(cmd.source_channel)}
                    </span>
                  </div>
                  <span className="sub">{cmd.summary || "—"}</span>
                </td>
                <td data-label="Client">
                  <div className="client-cell">
                    <strong>{cmd.client_name || cmd.client_id}</strong>
                    <span className="sub mono">
                      {cmd.client_phone || cmd.client_id}
                    </span>
                    <div className="client-tags">
                      {count <= 1 ? (
                        <span className="pill info">First order</span>
                      ) : (
                        <span className="pill">
                          Returning · {count} orders
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td data-label="Product">
                  <span>{cmd.product_name || cmd.product_id || "—"}</span>
                  <span className="sub mono">{cmd.product_id || ""}</span>
                </td>
                <td data-label="Qty">{qty(cmd.quantity)}</td>
                {!compact && <td data-label="Unit (€)">{money(cmd.price)}</td>}
                <td data-label="Status">
                  <span className={`pill ${statusPillClass(cmd.status)}`}>
                    {statusLabel(cmd.status)}
                  </span>
                </td>
                {!compact && <td data-label="Received">{dateLabel(cmd.recorded_at)}</td>}
                <td data-label="Decision" onClick={(e) => e.stopPropagation()}>
                  {editingCommandId === id ? (
                    <div className="decision-cell">
                      <div className="row-actions">
                        <input
                          className="decision-input"
                          type="number"
                          step="0.001"
                          min="0.001"
                          style={{ width: 82 }}
                          value={cmdEditForm.quantity}
                          onChange={(e) =>
                            setCmdEditForm((f) => ({ ...f, quantity: e.target.value }))
                          }
                        />
                        <select
                          className="decision-input"
                          value={cmdEditForm.status}
                          onChange={(e) =>
                            setCmdEditForm((f) => ({ ...f, status: e.target.value }))
                          }
                        >
                          <option value="new">new</option>
                          <option value="processed">approved</option>
                          <option value="rejected">rejected</option>
                          <option value="cancelled">cancelled</option>
                        </select>
                      </div>
                      <input
                        className="decision-input"
                        placeholder="Summary..."
                        value={cmdEditForm.summary}
                        onChange={(e) =>
                          setCmdEditForm((f) => ({ ...f, summary: e.target.value }))
                        }
                      />
                      <div className="row-actions">
                        <button
                          className="btn small primary"
                          type="button"
                          disabled={busyId === id}
                          onClick={() => void saveCommandEdit(id)}
                        >
                          Save
                        </button>
                        <button
                          className="btn small ghost"
                          type="button"
                          onClick={() => setEditingCommandId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : st === "new" ? (
                    <div className="decision-cell">
                      <input
                        className="decision-input"
                        placeholder="Optional WhatsApp comment to client..."
                        value={commentsById[id] || ""}
                        onChange={(e) =>
                          setCommentsById((prev) => ({
                            ...prev,
                            [id]: e.target.value,
                          }))
                        }
                      />
                      <div className="row-actions">
                        <button
                          className="btn small approve"
                          type="button"
                          disabled={busyId === id}
                          onClick={() => void handleDecision(cmd, true)}
                        >
                          Approve
                        </button>
                        <button
                          className="btn small reject"
                          type="button"
                          disabled={busyId === id}
                          onClick={() => void handleDecision(cmd, false)}
                        >
                          Reject
                        </button>
                        {!compact && (
                          <>
                            <button
                              className="btn ghost small"
                              type="button"
                              onClick={() => {
                                setEditingCommandId(id);
                                setCmdEditForm({
                                  quantity: String(cmd.quantity),
                                  status: String(cmd.status || "new"),
                                  summary: String(cmd.summary || ""),
                                });
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="btn ghost small reject"
                              type="button"
                              disabled={busyId === id}
                              onClick={() => void deleteCommand(id)}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="decision-cell">
                      <span className="sub">
                        {cmd.decision_comment
                          ? `“${cmd.decision_comment}”`
                          : "No comment"}{" "}
                        {cmd.decided_by ? `by ${cmd.decided_by}` : ""}
                      </span>
                      {!compact && (
                        <div className="row-actions">
                          <button
                            className="btn ghost small"
                            type="button"
                            onClick={() => {
                              setEditingCommandId(id);
                              setCmdEditForm({
                                quantity: String(cmd.quantity),
                                status: String(cmd.status || "new"),
                                summary: String(cmd.summary || ""),
                              });
                            }}
                          >
                            Edit
                          </button>
                          <button
                            className="btn ghost small reject"
                            type="button"
                            disabled={busyId === id}
                            onClick={() => void deleteCommand(id)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <div className="header-left">
            <button
              className="brand"
              type="button"
              onClick={() => setPage("dashboard")}
            >
              <BrandLogo size={30} />
            </button>
            <nav className="header-nav" aria-label="Primary navigation">
              {(
                [
                  ["dashboard", "Dashboard"],
                  ["commands", "Commands"],
                  ["products", "Products"],
                  ["clients", "Clients"],
                  ["pipeline", "Pipeline"],
                  ["call", "Live call"],
                  ...(role === "admin"
                    ? ([["settings", "Settings"]] as Array<[PageId, string]>)
                    : []),
                ] as Array<[PageId, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`nav-item${page === id ? " active" : ""}`}
                  onClick={() => setPage(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>

          <div className="header-right">
            {role === "admin" && (
              <button
                type="button"
                className={`pill status-link ${wa.status === "connected" ? "ok" : wa.status === "qr_pending" || wa.status === "connecting" || wa.status === "checking" ? "warn" : "bad"}`}
                onClick={() => setPage("settings")}
              >
                <span className="dot" />
                <span className="wa-prefix">WhatsApp · </span>
                <span>{waLabel}</span>
              </button>
            )}
            <button
              type="button"
              className="btn ghost small desktop-only"
              onClick={() =>
                setThemeState((t) => (t === "dark" ? "light" : "dark"))
              }
            >
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
            <span className="user-chip">
              {username.toLowerCase() === role.toLowerCase()
                ? username
                : `${username} · ${role}`}
            </span>
            <button
              type="button"
              className="btn ghost small desktop-only"
              onClick={onLogout}
            >
              Sign out
            </button>
            <button
              type="button"
              className="btn ghost small menu-toggle"
              aria-expanded={mobileMenu}
              onClick={() => setMobileMenu((m) => !m)}
            >
              {mobileMenu ? "Close" : "Menu"}
            </button>
          </div>
        </div>

        {mobileMenu && (
          <nav className="mobile-nav" aria-label="Mobile navigation">
            {(
              [
                ["dashboard", "Dashboard"],
                ["commands", "Commands"],
                ["products", "Products"],
                ["clients", "Clients"],
                ["pipeline", "Pipeline"],
                ["call", "Live call"],
                ...(role === "admin"
                  ? ([["settings", "Settings"]] as Array<[PageId, string]>)
                  : []),
              ] as Array<[PageId, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`nav-item${page === id ? " active" : ""}`}
                onClick={() => {
                  setPage(id);
                  setMobileMenu(false);
                }}
              >
                {label}
              </button>
            ))}
            <div className="mobile-nav-actions">
              <button
                type="button"
                className="btn ghost small"
                onClick={() =>
                  setThemeState((t) => (t === "dark" ? "light" : "dark"))
                }
              >
                {theme === "dark" ? "Light mode" : "Dark mode"}
              </button>
              <button
                type="button"
                className="btn ghost small reject"
                onClick={() => {
                  setMobileMenu(false);
                  onLogout();
                }}
              >
                Sign out
              </button>
            </div>
          </nav>
        )}
      </header>

      <main className="main">
        <div className="page-head">
          <div>
            <h1>{pageMeta[page][0]}</h1>
            <p className="muted">{pageMeta[page][1]}</p>
          </div>
        </div>

        {page === "dashboard" && (
          <section>
            <div className="kpi-strip">
              <article className="stat-card">
                <div className="label">Commands</div>
                <div className="value">{commands.length}</div>
                <div className="hint">
                  {pendingOrders} pending · {approvedOrders} approved
                </div>
              </article>
              <article className="stat-card">
                <div className="label">Registered clients</div>
                <div className="value">{clients.length}</div>
                <div className="hint">strict WhatsApp allowlist</div>
              </article>
              <article className="stat-card">
                <div className="label">Catalogue products</div>
                <div className="value">{products.length}</div>
                <div className="hint">active items</div>
              </article>
              <article className="stat-card">
                <div className="label">WhatsApp line</div>
                <div className="value">{waLabel}</div>
                <div className="hint">
                  {wa.phone ? wa.phone.split(":")[0] : "ready"}
                </div>
              </article>
            </div>

            <div className="dashboard-grid">
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h2>Incoming &amp; recent commands</h2>
                    <p className="panel-note muted">
                      Approve or reject orders with an optional WhatsApp reply
                      to the buyer.
                    </p>
                  </div>
                  <button
                    className="btn ghost small"
                    type="button"
                    onClick={() => setPage("commands")}
                  >
                    All commands
                  </button>
                </div>
                <div className="table-wrap">
                  {renderCommandTable(commands.slice(0, 8), true)}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h2>Decision &amp; pipeline feed</h2>
                    <p className="panel-note muted">
                      Real-time approvals, rejections and WhatsApp intake logs.
                    </p>
                  </div>
                  <button
                    className="btn ghost small"
                    type="button"
                    onClick={() => setPage("pipeline")}
                  >
                    Open pipeline
                  </button>
                </div>
                <div className="activity-list">
                  {logs.length === 0 ? (
                    <p className="empty">
                      No pipeline events yet. Send a WhatsApp order or run a live call test to watch events stream in real time.
                    </p>
                  ) : (
                    logs.slice(0, 10).map((item) => (
                      <div key={item.log_id} className="activity-item">
                        <div className="activity-head">
                          <span className="mono">{item.event_type}</span>
                          <span
                            className={`pill ${statusPillClass(item.status)}`}
                          >
                            {statusLabel(item.status)}
                          </span>
                        </div>
                        <div className="activity-body">{item.message}</div>
                        <span className="sub">{dateLabel(item.created_at)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {page === "commands" && (
          <section>
            <div className="toolbar">
              <input
                className="input"
                placeholder="Search client, phone, product or summary..."
                value={commandSearch}
                onChange={(e) => setCommandSearch(e.target.value)}
              />
              <select
                className="input narrow"
                value={commandStatus}
                onChange={(e) => setCommandStatus(e.target.value)}
              >
                <option value="all">All statuses</option>
                <option value="new">New (pending)</option>
                <option value="processed">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <select
                className="input narrow"
                value={commandClientType}
                onChange={(e) => setCommandClientType(e.target.value)}
              >
                <option value="all">All clients</option>
                <option value="new">First-time client</option>
                <option value="returning">Returning client</option>
              </select>
              <button
                className="btn primary"
                type="button"
                onClick={() => setNewCmdOpen((o) => !o)}
              >
                {newCmdOpen ? "Close form" : "+ New order"}
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={() => void loadAll()}
              >
                Refresh
              </button>
            </div>
            {newCmdOpen && (
              <div className="panel" style={{ marginBottom: 16 }}>
                <div className="panel-head">
                  <h2>Create manual order</h2>
                </div>
                <form className="toolbar" onSubmit={(e) => void submitNewCommand(e)}>
                  <select
                    className="input"
                    value={newCmdForm.client_id || clients[0]?.client_id || ""}
                    onChange={(e) =>
                      setNewCmdForm((f) => ({ ...f, client_id: e.target.value }))
                    }
                  >
                    {clients.map((c) => (
                      <option key={c.client_id} value={c.client_id}>
                        {c.client_name} ({c.phone_number})
                      </option>
                    ))}
                  </select>
                  <select
                    className="input"
                    value={newCmdForm.product_id || products[0]?.product_id || ""}
                    onChange={(e) =>
                      setNewCmdForm((f) => ({ ...f, product_id: e.target.value }))
                    }
                  >
                    {products.map((p) => (
                      <option key={p.product_id} value={p.product_id}>
                        {p.product_name || p.product_id} ({money(p.price)} €)
                      </option>
                    ))}
                  </select>
                  <input
                    className="input narrow"
                    type="number"
                    step="0.001"
                    min="0.001"
                    value={newCmdForm.quantity}
                    onChange={(e) =>
                      setNewCmdForm((f) => ({ ...f, quantity: e.target.value }))
                    }
                    placeholder="Qty"
                    required
                  />
                  <input
                    className="input"
                    value={newCmdForm.summary}
                    onChange={(e) =>
                      setNewCmdForm((f) => ({ ...f, summary: e.target.value }))
                    }
                    placeholder="Optional note..."
                  />
                  <button className="btn primary" type="submit">
                    Create order
                  </button>
                </form>
              </div>
            )}
            <div className="panel table-wrap">
              {renderCommandTable(filteredCommands, false)}
            </div>
          </section>
        )}

        {page === "products" && (
          <section
            className={`split-layout${role !== "admin" ? " single-col" : ""}`}
          >
            <div className="panel">
              <div className="panel-head">
                <h2>Product catalogue</h2>
                <span className="pill muted">{products.length} items</span>
              </div>
              <div className="table-wrap">
                <table className="responsive-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Product</th>
                      <th>Price (€)</th>
                      <th>Stock</th>
                      {role === "admin" && <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => {
                      const stk = Number(p.stock || 0);
                      const name = p.product_name || p.article_name || p.product_id;
                      return (
                        <tr key={p.product_id}>
                          <td data-label="ID" className="mono">{p.product_id}</td>
                          <td data-label="Product">{name}</td>
                          <td data-label="Price (€)">{money(p.price)}</td>
                          <td data-label="Stock">
                            {qty(p.stock)}{" "}
                            {stk <= 0 ? (
                              <span className="pill bad">Out of stock</span>
                            ) : stk <= 5 ? (
                              <span className="pill warn">Low stock</span>
                            ) : (
                              <span className="pill ok">In stock</span>
                            )}
                          </td>
                          {role === "admin" && (
                            <td data-label="Actions">
                              <div className="row-actions">
                                <button
                                  className="btn ghost small"
                                  type="button"
                                  onClick={() => {
                                    setEditingProductId(p.product_id);
                                    setProdForm({
                                      product_id: p.product_id,
                                      product_name: name,
                                      price: String(p.price),
                                      stock: String(p.stock),
                                    });
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  className="btn ghost small reject"
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      await api.deleteProduct(p.product_id);
                                      const [prods, cmds] = await Promise.all([
                                        api.getProducts(),
                                        api.getCommands(),
                                      ]);
                                      setProducts(prods);
                                      setCommands(cmds);
                                      showToast(`Deleted ${p.product_id}`);
                                    } catch (err) {
                                      showToast(
                                        err instanceof Error ? err.message : "Delete failed",
                                        true,
                                      );
                                    }
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {role === "admin" && (
              <div className="panel">
                <div className="panel-head">
                  <h2>
                    {editingProductId
                      ? `Edit ${editingProductId}`
                      : "Add product"}
                  </h2>
                  {editingProductId && (
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => {
                        setEditingProductId(null);
                        setProdForm({
                          product_id: "",
                          product_name: "",
                          price: "",
                          stock: "",
                        });
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
                <form className="stack" onSubmit={(e) => void submitProduct(e)}>
                  <label>
                    Product ID
                    <input
                      value={prodForm.product_id}
                      readOnly={Boolean(editingProductId)}
                      onChange={(e) =>
                        setProdForm((f) => ({
                          ...f,
                          product_id: e.target.value,
                        }))
                      }
                      placeholder="ART-TOM-GR-01"
                      required
                    />
                  </label>
                  <label>
                    Product name
                    <input
                      value={prodForm.product_name}
                      onChange={(e) =>
                        setProdForm((f) => ({
                          ...f,
                          product_name: e.target.value,
                        }))
                      }
                      placeholder="Tomates grappe"
                      required
                    />
                  </label>
                  <label>
                    Unit price (€)
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={prodForm.price}
                      onChange={(e) =>
                        setProdForm((f) => ({ ...f, price: e.target.value }))
                      }
                      required
                    />
                  </label>
                  <label>
                    Available stock
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      value={prodForm.stock}
                      onChange={(e) =>
                        setProdForm((f) => ({ ...f, stock: e.target.value }))
                      }
                      required
                    />
                  </label>
                  <button className="btn primary" type="submit">
                    {editingProductId ? "Save changes" : "Save product"}
                  </button>
                </form>
              </div>
            )}
          </section>
        )}

        {page === "clients" && (
          <section>
            <div
              className={`split-layout${role !== "admin" ? " single-col" : ""}`}
            >
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h2>Registered clients</h2>
                    <p className="panel-note muted">
                      Only contacts listed here can trigger the WhatsApp order
                      pipeline. Click a row to open the client profile.
                    </p>
                  </div>
                  <span className="pill muted">{clients.length} clients</span>
                </div>
                <div className="table-wrap">
                  <table className="responsive-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Client</th>
                        <th>WhatsApp phone</th>
                        <th>Orders</th>
                        <th>Total (€)</th>
                        <th>Usual item</th>
                        {role === "admin" && <th>Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {clients.map((c) => {
                        const count = Number(c.order_count || 0);
                        return (
                          <tr
                            key={c.client_id}
                            className={`clickable-row${selectedClientId === c.client_id ? " selected" : ""}`}
                            onClick={() => void openClientProfile(c.client_id)}
                          >
                            <td data-label="ID" className="mono">{c.client_id}</td>
                            <td data-label="Client">
                              <strong>{c.client_name}</strong>
                              <span className="sub">
                                {count === 0
                                  ? "No order yet"
                                  : count === 1
                                    ? "First-time buyer"
                                    : `Returning buyer (${count} orders)`}
                              </span>
                            </td>
                            <td data-label="WhatsApp">{c.phone_number}</td>
                            <td data-label="Orders">{count}</td>
                            <td data-label="Total (€)">{money(c.total_spent)}</td>
                            <td data-label="Usual item" className="mono">{c.usual_product || "—"}</td>
                            {role === "admin" && (
                              <td data-label="Actions" onClick={(e) => e.stopPropagation()}>
                                <div className="row-actions">
                                  <button
                                    className="btn ghost small"
                                    type="button"
                                    onClick={() => {
                                      setEditingClientId(c.client_id);
                                      setCliForm({
                                        client_id: c.client_id,
                                        phone_number: c.phone_number,
                                        client_name: c.client_name,
                                      });
                                    }}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    className="btn ghost small reject"
                                    type="button"
                                    onClick={async () => {
                                      try {
                                        await api.deleteClient(c.client_id);
                                        if (selectedClientId === c.client_id) {
                                          setSelectedClientId(null);
                                          setClientDetail(null);
                                        }
                                        const [clis, cmds] = await Promise.all([
                                          api.getClients(),
                                          api.getCommands(),
                                        ]);
                                        setClients(clis);
                                        setCommands(cmds);
                                        showToast(`Deleted ${c.client_id}`);
                                      } catch (err) {
                                        showToast(
                                          err instanceof Error ? err.message : "Delete failed",
                                          true,
                                        );
                                      }
                                    }}
                                  >
                                    Delete
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {role === "admin" && (
                <div className="panel">
                  <div className="panel-head">
                    <h2>
                      {editingClientId
                        ? `Edit ${editingClientId}`
                        : "Add client"}
                    </h2>
                    {editingClientId && (
                      <button
                        className="btn ghost small"
                        type="button"
                        onClick={() => {
                          setEditingClientId(null);
                          setCliForm({
                            client_id: "",
                            phone_number: "",
                            client_name: "",
                          });
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  <form
                    className="stack"
                    onSubmit={(e) => void submitClient(e)}
                  >
                    <label>
                      Client ID
                      <input
                        value={cliForm.client_id}
                        readOnly={Boolean(editingClientId)}
                        onChange={(e) =>
                          setCliForm((f) => ({
                            ...f,
                            client_id: e.target.value,
                          }))
                        }
                        placeholder="CLI-0002"
                        required
                      />
                    </label>
                    <label>
                      WhatsApp phone (E.164 digits)
                      <input
                        value={cliForm.phone_number}
                        onChange={(e) =>
                          setCliForm((f) => ({
                            ...f,
                            phone_number: e.target.value,
                          }))
                        }
                        placeholder="33745746025"
                        required
                      />
                    </label>
                    <label>
                      Client name
                      <input
                        value={cliForm.client_name}
                        onChange={(e) =>
                          setCliForm((f) => ({
                            ...f,
                            client_name: e.target.value,
                          }))
                        }
                        placeholder="Yohann Bikele"
                        required
                      />
                    </label>
                    <button className="btn primary" type="submit">
                      {editingClientId ? "Save changes" : "Save client"}
                    </button>
                  </form>
                </div>
              )}
            </div>

            {clientDetail && (
              <div className="panel client-inspector">
                <div className="panel-head">
                  <div>
                    <h2>
                      {clientDetail.client.client_name} (
                      {clientDetail.client.client_id})
                    </h2>
                    <p className="panel-note muted">
                      WhatsApp {clientDetail.client.phone_number} ·{" "}
                      {clientDetail.stats.order_count} recorded order(s)
                    </p>
                  </div>
                  <button
                    className="btn ghost small"
                    type="button"
                    onClick={() => {
                      setSelectedClientId(null);
                      setClientDetail(null);
                    }}
                  >
                    Close profile
                  </button>
                </div>

                <div className="kpi-strip compact">
                  <article className="stat-card">
                    <div className="label">Orders</div>
                    <div className="value">
                      {clientDetail.stats.order_count}
                    </div>
                    <div className="hint">
                      {clientDetail.stats.order_count <= 1
                        ? "First-time profile"
                        : "Returning profile"}
                    </div>
                  </article>
                  <article className="stat-card">
                    <div className="label">Total spent (€)</div>
                    <div className="value">
                      {money(clientDetail.stats.total_spent)}
                    </div>
                    <div className="hint">
                      {qty(clientDetail.stats.total_quantity)} total units
                    </div>
                  </article>
                  <article className="stat-card">
                    <div className="label">Usual product</div>
                    <div className="value">
                      {clientDetail.stats.usual_product || "—"}
                    </div>
                    <div className="hint">most recent item ordered</div>
                  </article>
                  <article className="stat-card">
                    <div className="label">Last order</div>
                    <div className="value">
                      {dateLabel(clientDetail.stats.last_order_at)}
                    </div>
                    <div className="hint">latest activity</div>
                  </article>
                </div>

                <div className="table-wrap">
                  <table className="responsive-table">
                    <thead>
                      <tr>
                        <th>Command</th>
                        <th>Product</th>
                        <th>Qty</th>
                        <th>Price (€)</th>
                        <th>Status</th>
                        <th>Decision comment</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clientDetail.commands.map((cmd) => (
                        <tr
                          key={cmd.command_id}
                          className="clickable-row"
                          onClick={() => void openCommandDetail(cmd.command_id)}
                        >
                          <td data-label="Command">
                            <div className="cmd-id-row">
                              <span className="mono">{cmd.command_id}</span>
                              <span className={`pill ${sourceChannelTone(cmd.source_channel)}`}>
                                {sourceChannelLabel(cmd.source_channel)}
                              </span>
                            </div>
                            <span className="sub">{cmd.summary || ""}</span>
                          </td>
                          <td data-label="Product">
                            {cmd.product_name || cmd.product_id}{" "}
                            <span className="sub mono">{cmd.product_id}</span>
                          </td>
                          <td data-label="Qty">{qty(cmd.quantity)}</td>
                          <td data-label="Price (€)">{money(cmd.price)}</td>
                          <td data-label="Status">
                            <span
                              className={`pill ${statusPillClass(cmd.status)}`}
                            >
                              {statusLabel(cmd.status)}
                            </span>
                          </td>
                          <td data-label="Decision">
                            {cmd.decision_comment || "—"}{" "}
                            {cmd.decided_by && (
                              <span className="sub">by {cmd.decided_by}</span>
                            )}
                          </td>
                          <td data-label="Date">{dateLabel(cmd.recorded_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

        {page === "pipeline" && (
          <section className="n8n-workspace">
            <div className="n8n-toolbar">
              <div className="n8n-toolbar-left">
                <span
                  className={`pill ${sseState === "open" ? "ok" : "warn"}`}
                >
                  <span className="dot" />
                  <span>
                    {sseState === "open"
                      ? "Live stream connected"
                      : "Reconnecting stream..."}
                  </span>
                </span>
                <span className="n8n-hint muted">
                  Drag any node to rearrange · Drag background to pan · Click a
                  node to inspect
                </span>
              </div>
              <div className="n8n-toolbar-right">
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={() =>
                    setZoom((z) => Math.max(0.55, Number((z - 0.1).toFixed(2))))
                  }
                >
                  −
                </button>
                <span className="mono muted">{Math.round(zoom * 100)}%</span>
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={() =>
                    setZoom((z) => Math.min(1.35, Number((z + 0.1).toFixed(2))))
                  }
                >
                  +
                </button>
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={() => {
                    localStorage.removeItem(POS_KEY);
                    setNodePositions({});
                    setZoom(0.86);
                    setPan({ x: 14, y: 10 });
                    showToast("Graph layout tidied");
                  }}
                >
                  Tidy layout
                </button>
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={async () => {
                    setLogs(await api.getPipelineLogs(120));
                    showToast("Pipeline logs refreshed");
                  }}
                >
                  Refresh
                </button>
              </div>
            </div>

            <div
              className={`n8n-viewport${panning ? " panning" : ""}`}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={handleCanvasPointerUp}
            >
              <div
                className="n8n-world"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                }}
              >
                <svg
                  className="n8n-edges"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  {GRAPH_EDGES.map(([fromId, toId]) => {
                    const fromDef = GRAPH_NODES.find((n) => n.id === fromId);
                    const toDef = GRAPH_NODES.find((n) => n.id === toId);
                    if (!fromDef || !toDef) return null;
                    const from = getNodePos(fromDef);
                    const to = getNodePos(toDef);
                    const x1 = from.x + 214;
                    const y1 = from.y + 41;
                    const x2 = to.x;
                    const y2 = to.y + 41;
                    const dx = Math.max(54, Math.abs(x2 - x1) * 0.48);
                    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
                    const hot = Boolean(
                      nodePayloads[fromId] && nodePayloads[toId],
                    );
                    return (
                      <g key={`${fromId}->${toId}`}>
                        <path className="n8n-edge-base" d={d} />
                        <path
                          className={`n8n-edge-flow${hot ? " hot" : ""}`}
                          d={d}
                        />
                      </g>
                    );
                  })}
                </svg>

                <div className="n8n-nodes">
                  {GRAPH_NODES.map((def) => {
                    const pos = getNodePos(def);
                    const last = nodePayloads[def.id];
                    const count = nodeCounts[def.id] || 0;
                    const st = String(last?.status || "").toLowerCase();
                    const stateCls = !last
                      ? ""
                      : st === "rejected" || st === "cancelled"
                        ? " active-bad"
                        : st === "new" ||
                            st === "new_client" ||
                            st === "received"
                          ? " active-warn"
                          : " active-ok";
                    return (
                      <div
                        key={def.id}
                        data-graph-node={def.id}
                        className={`n8n-node${selectedDef.id === def.id ? " selected" : ""}${stateCls}`}
                        style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
                      >
                        {def.hasIn && <span className="n8n-port in" />}
                        <div className="n8n-node-top">
                          <span className="n8n-node-badge">{def.badge}</span>
                          <span className="n8n-node-runs">{count}×</span>
                        </div>
                        <strong>{def.title}</strong>
                        <span className="n8n-node-meta">
                          {last?.message || def.stage}
                        </span>
                        {def.hasOut && <span className="n8n-port out" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="n8n-drawer">
              <div className="n8n-drawer-col">
                <div className="panel-head">
                  <div>
                    <h2>
                      {selectedDef.title} ({selectedDef.id})
                    </h2>
                    <p className="panel-note muted">{selectedDef.role}</p>
                  </div>
                  <span className="pill muted">{selectedDef.stage}</span>
                </div>
                <div className="spec-block">
                  <div className="spec-label">Data structure / contract</div>
                  <pre className="code-block compact">{selectedDef.schema}</pre>
                </div>
                <div className="spec-block">
                  <div className="spec-label">Concrete example</div>
                  <pre className="code-block compact">
                    {JSON.stringify(selectedDef.example, null, 2)}
                  </pre>
                </div>
              </div>

              <div className="n8n-drawer-col">
                <div className="panel-head">
                  <div>
                    <h2>
                      {selectedLiveItem
                        ? `${selectedDef.title} · ${selectedLiveItem.event_type}`
                        : `${selectedDef.title} · Ready`}
                    </h2>
                    <p className="panel-note muted">
                      {selectedLiveItem
                        ? `Captured at ${dateLabel(selectedLiveItem.created_at)} · status: ${selectedLiveItem.status}`
                        : "No runtime event captured on this node yet; showing default payload."}
                    </p>
                  </div>
                  <span
                    className={`pill ${(nodeCounts[selectedDef.id] || 0) > 0 ? "ok" : "muted"}`}
                  >
                    {nodeCounts[selectedDef.id] || 0} runs
                  </span>
                </div>
                <pre className="code-block">
                  {JSON.stringify(
                    selectedLiveItem
                      ? selectedLiveItem.payload
                      : selectedDef.example,
                    null,
                    2,
                  )}
                </pre>
              </div>

              <div className="n8n-drawer-col">
                <div className="panel-head">
                  <div>
                    <h2>Enumerated execution log</h2>
                    <p className="panel-note muted">
                      Step-by-step trace of all signals, transcriptions, tool
                      calls and decisions.
                    </p>
                  </div>
                  <div className="row-actions">
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => setFilterByNode((f) => !f)}
                    >
                      {filterByNode
                        ? `Filter: ${selectedDef.id}`
                        : "All nodes"}
                    </button>
                    <span className="pill muted">
                      {visibleEnumLogs.length} steps
                    </span>
                  </div>
                </div>
                <ol className="enum-log-list">
                  {visibleEnumLogs.map((item, idx) => {
                    const stepNum = String(
                      visibleEnumLogs.length - idx,
                    ).padStart(2, "0");
                    return (
                      <li
                        key={item.log_id}
                        className={`enum-log-item${selectedLogId === item.log_id ? " active" : ""}`}
                        onClick={() => {
                          setSelectedLogId(item.log_id);
                          if (item.node_id) setSelectedNodeId(item.node_id);
                        }}
                      >
                        <span className="enum-num">#{stepNum}</span>
                        <div className="enum-body">
                          <div className="enum-head">
                            <span className="mono">
                              {item.node_id || "pipeline"} · {item.event_type}
                            </span>
                            <span
                              className={`pill ${statusPillClass(item.status)}`}
                            >
                              {statusLabel(item.status)}
                            </span>
                          </div>
                          <div className="enum-msg">{item.message}</div>
                          <div className="enum-time">
                            {dateLabel(item.created_at)}
                            {item.phone_number ? ` · ${item.phone_number}` : ""}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          </section>
        )}

        {page === "call" && (
          <section className="panel">
            <CallPanel
              activeCall={activeCall}
              recentCalls={recentCalls}
              selectedCallId={selectedCallId}
              webrtcState={webrtcState}
              callBusy={callBusy}
              clients={clients}
              onSelectCall={(cid) => setSelectedCallId(cid)}
              onInspectCommand={(cmdId) => void openCommandDetail(cmdId)}
              onAnswer={(cid) => void answerCall(cid)}
              onReject={(cid) => void rejectCall(cid)}
              onHangup={(cid) => void hangupCall(cid)}
              onToggleMute={(cid, m) => void toggleCallMute(cid, m)}
              onCommitOrder={(cid) => void commitCallOrder(cid)}
              onSimulateCall={simulateIncomingCall}
              onInjectText={injectCallText}
            />
          </section>
        )}

        {page === "settings" && role === "admin" && (
          <section>
            <div className="settings-grid">
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h2>WhatsApp line</h2>
                    <p className="panel-note muted">
                      Link the primary WhatsApp number that receives client
                      orders and sends approval notifications.
                    </p>
                  </div>
                  <span
                    className={`pill ${wa.status === "connected" ? "ok" : wa.status === "qr_pending" ? "warn" : "bad"}`}
                  >
                    {waLabel}
                  </span>
                </div>

                <div className="meta-rows">
                  <div className="meta-row">
                    <span className="muted">Connection status</span>
                    <strong>{waLabel}</strong>
                  </div>
                  <div className="meta-row">
                    <span className="muted">Linked phone</span>
                    <strong>
                      {wa.phone ? wa.phone.split(":")[0] : "Not linked"}
                    </strong>
                  </div>
                  <div className="meta-row">
                    <span className="muted">Intake rule</span>
                    <strong>
                      Registered clients only (strict phone match)
                    </strong>
                  </div>
                </div>

                <div className="actions">
                  <button
                    className="btn primary"
                    type="button"
                    disabled={waActionBusy}
                    onClick={async () => {
                      setWaActionBusy(true);
                      try {
                        setQrDataUrl("");
                        setWa({ status: "connecting", phone: "", qr_ready: false });
                        await api.waConnect(true);
                        showToast("Fresh WhatsApp QR requested — waiting for pairing code...");
                        await refreshWa("admin");
                      } catch (err) {
                        showToast(
                          err instanceof Error ? err.message : "QR request failed",
                          true,
                        );
                      } finally {
                        setWaActionBusy(false);
                      }
                    }}
                  >
                    {waActionBusy ? "Working..." : "Generate / refresh QR"}
                  </button>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={waActionBusy}
                    onClick={async () => {
                      setWaActionBusy(true);
                      try {
                        await api.waDisconnect();
                        setQrDataUrl("");
                        setWa({ status: "disconnected", phone: "", qr_ready: false });
                        showToast("WhatsApp disconnected");
                        await refreshWa("admin");
                      } catch (err) {
                        showToast(
                          err instanceof Error ? err.message : "Disconnect failed",
                          true,
                        );
                      } finally {
                        setWaActionBusy(false);
                      }
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h2>WhatsApp pairing QR</h2>
                    <p className="panel-note muted">
                      When disconnected, scan from WhatsApp → Linked devices.
                    </p>
                  </div>
                </div>
                <div className="qr-stage">
                  {wa.status === "connected" ? (
                    <p className="empty">
                      WhatsApp is connected (
                      {wa.phone ? wa.phone.split(":")[0] : "active"}).
                    </p>
                  ) : qrDataUrl ? (
                    <div>
                      <div className="qr-frame">
                        <img src={qrDataUrl} alt="WhatsApp pairing QR code" />
                      </div>
                      <p className="qr-caption">
                        Scan with WhatsApp Linked devices
                      </p>
                    </div>
                  ) : (
                    <p className="empty">
                      No active QR code. Click “Generate / refresh QR”.
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="split-layout settings-managers">
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h2>Managers</h2>
                    <p className="panel-note muted">
                      Managers can view the dashboard, commands, catalogue,
                      clients and pipeline, and approve or reject orders. Only
                      the admin can access Settings.
                    </p>
                  </div>
                  <span className="pill muted">{managers.length} managers</span>
                </div>
                <div className="table-wrap">
                  {managers.length ? (
                    <table className="responsive-table">
                      <thead>
                        <tr>
                          <th>Username</th>
                          <th>Status</th>
                          <th>Created</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {managers.map((m) => (
                          <tr key={m.username}>
                            <td data-label="Username" className="mono">{m.username}</td>
                            <td data-label="Status">
                              {m.is_active ? (
                                <span className="pill ok">active</span>
                              ) : (
                                <span className="pill bad">disabled</span>
                              )}
                            </td>
                            <td data-label="Created">{dateLabel(m.created_at)}</td>
                            <td data-label="Actions">
                              <div className="row-actions">
                                <button
                                  className="btn ghost small"
                                  type="button"
                                  onClick={() => {
                                    setEditingManager(m.username);
                                    setMgrForm({
                                      username: m.username,
                                      password: "",
                                    });
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  className="btn ghost small"
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      await api.updateManager(m.username, {
                                        is_active: !m.is_active,
                                      });
                                      setManagers(await api.getManagers());
                                      showToast(
                                        `${m.username} ${!m.is_active ? "enabled" : "disabled"}`,
                                      );
                                    } catch (err) {
                                      showToast(
                                        err instanceof Error ? err.message : "Update failed",
                                        true,
                                      );
                                    }
                                  }}
                                >
                                  {m.is_active ? "Disable" : "Enable"}
                                </button>
                                <button
                                  className="btn ghost small reject"
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      await api.deleteManager(m.username);
                                      setManagers(await api.getManagers());
                                      showToast(`Deleted ${m.username}`);
                                    } catch (err) {
                                      showToast(
                                        err instanceof Error ? err.message : "Delete failed",
                                        true,
                                      );
                                    }
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="empty">
                      No managers created yet. Only the root admin account is
                      active.
                    </p>
                  )}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <h2>
                    {editingManager
                      ? `Update ${editingManager}`
                      : "Create manager"}
                  </h2>
                  {editingManager && (
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => {
                        setEditingManager(null);
                        setMgrForm({ username: "", password: "" });
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
                <form className="stack" onSubmit={(e) => void submitManager(e)}>
                  <label>
                    Username
                    <input
                      value={mgrForm.username}
                      readOnly={Boolean(editingManager)}
                      onChange={(e) =>
                        setMgrForm((f) => ({ ...f, username: e.target.value }))
                      }
                      placeholder="manager-username"
                      required
                    />
                  </label>
                  <label>
                    Password
                    <input
                      type="password"
                      minLength={6}
                      value={mgrForm.password}
                      onChange={(e) =>
                        setMgrForm((f) => ({ ...f, password: e.target.value }))
                      }
                      placeholder="Min 6 characters"
                      required={!editingManager}
                    />
                  </label>
                  <button className="btn primary" type="submit">
                    Save manager
                  </button>
                </form>
              </div>
            </div>
          </section>
        )}
      </main>

      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />

      {(selectedCommandDetail || commandDetailLoading) && (
        <div
          className="drawer-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setSelectedCommandDetail(null)}
        >
          <aside
            className="command-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            {commandDetailLoading && !selectedCommandDetail ? (
              <div className="drawer-head">
                <div>
                  <h2>Loading order provenance...</h2>
                  <p className="muted" style={{ fontSize: 13 }}>
                    Fetching source channel, transcripts and pipeline trace.
                  </p>
                </div>
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={() => {
                    setCommandDetailLoading(false);
                    setSelectedCommandDetail(null);
                  }}
                >
                  Close
                </button>
              </div>
            ) : selectedCommandDetail ? (
              <>
                <div className="drawer-head">
                  <div>
                    <div className="cmd-id-row">
                      <span className="mono" style={{ fontSize: 13 }}>
                        {selectedCommandDetail.command.command_id}
                      </span>
                      <span
                        className={`pill ${statusPillClass(selectedCommandDetail.command.status)}`}
                      >
                        {statusLabel(selectedCommandDetail.command.status)}
                      </span>
                      <span
                        className={`pill ${sourceChannelTone(selectedCommandDetail.command.source_channel)}`}
                      >
                        {sourceChannelLabel(selectedCommandDetail.command.source_channel)}
                      </span>
                    </div>
                    <h2 style={{ marginTop: 6 }}>
                      {selectedCommandDetail.command.product_name ||
                        selectedCommandDetail.command.product_id}{" "}
                      · {qty(selectedCommandDetail.command.quantity)} unit(s)
                    </h2>
                    <p className="muted" style={{ fontSize: 13 }}>
                      {selectedCommandDetail.command.client_name ||
                        selectedCommandDetail.command.client_id}{" "}
                      ({selectedCommandDetail.command.client_phone ||
                        selectedCommandDetail.command.client_id}) ·{" "}
                      {dateLabel(selectedCommandDetail.command.recorded_at)}
                    </p>
                  </div>
                  <button
                    className="btn ghost small"
                    type="button"
                    onClick={() => setSelectedCommandDetail(null)}
                  >
                    Close
                  </button>
                </div>

                <div className="drawer-section">
                  <div className="spec-label">Order &amp; Decision Details</div>
                  <div className="meta-rows">
                    <div className="meta-row">
                      <span className="muted">Summary</span>
                      <strong>{selectedCommandDetail.command.summary || "—"}</strong>
                    </div>
                    <div className="meta-row">
                      <span className="muted">Unit price / Total</span>
                      <strong>
                        {money(selectedCommandDetail.command.price)} € ·{" "}
                        {money(
                          Number(selectedCommandDetail.command.price || 0) *
                            Number(selectedCommandDetail.command.quantity || 0),
                        )}{" "}
                        €
                      </strong>
                    </div>
                    <div className="meta-row">
                      <span className="muted">Delivery date</span>
                      <strong>{selectedCommandDetail.command.delivery_date || "—"}</strong>
                    </div>
                    {selectedCommandDetail.command.decided_by && (
                      <div className="meta-row">
                        <span className="muted">Decision</span>
                        <strong>
                          {selectedCommandDetail.command.decision_comment || "Approved/Rejected"} ·{" "}
                          by {selectedCommandDetail.command.decided_by}
                        </strong>
                      </div>
                    )}
                  </div>
                </div>

                <div className="drawer-section">
                  <div className="spec-label">Origin &amp; Provenance</div>
                  <div className="meta-rows">
                    <div className="meta-row">
                      <span className="muted">Source channel</span>
                      <strong>
                        {sourceChannelLabel(selectedCommandDetail.command.source_channel)}
                      </strong>
                    </div>
                    {selectedCommandDetail.command.source_call_id && (
                      <div className="meta-row">
                        <span className="muted">Call session</span>
                        <div className="row-actions">
                          <span className="mono">
                            {selectedCommandDetail.command.source_call_id}
                          </span>
                          <button
                            className="btn small ghost"
                            type="button"
                            onClick={() =>
                              openCallInDesk(selectedCommandDetail.command.source_call_id || "")
                            }
                          >
                            Open in Call Desk
                          </button>
                        </div>
                      </div>
                    )}
                    {selectedCommandDetail.command.source_evenement_id && (
                      <div className="meta-row">
                        <span className="muted">Signal / Event ID</span>
                        <strong className="mono">
                          {selectedCommandDetail.command.source_evenement_id}
                        </strong>
                      </div>
                    )}
                    {selectedCommandDetail.command.source_metadata &&
                      Object.keys(selectedCommandDetail.command.source_metadata).length > 0 && (
                        <div className="meta-row">
                          <span className="muted">AI stack</span>
                          <strong className="mono" style={{ fontSize: 12 }}>
                            {String(
                              selectedCommandDetail.command.source_metadata.llm_model || "nemotron",
                            )}
                          </strong>
                        </div>
                      )}
                  </div>

                  {selectedCommandDetail.command.source_raw_text && (
                    <div className="spec-block" style={{ marginTop: 10 }}>
                      <div className="spec-label">Captured raw source text / prompt input</div>
                      <pre className="code-block compact">
                        {selectedCommandDetail.command.source_raw_text}
                      </pre>
                    </div>
                  )}
                </div>

                {selectedCommandDetail.call_session && (
                  <div className="drawer-section">
                    <div className="spec-label">
                      Linked call dialogue (Client &amp; Manager)
                    </div>
                    <div className="transcript compact-transcript">
                      {selectedCommandDetail.call_session.transcripts.length === 0 ? (
                        <p className="empty">No speech segments captured.</p>
                      ) : (
                        selectedCommandDetail.call_session.transcripts.map((t) => {
                          const isMgr = t.speaker === "manager";
                          return (
                            <div
                              key={t.id}
                              className={`transcript-entry ${isMgr ? "manager" : "client"}`}
                            >
                              <span className="speaker">
                                {isMgr
                                  ? "Manager"
                                  : selectedCommandDetail.command.client_name || "Client"}
                              </span>
                              <span className="text">{t.text}</span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}

                {selectedCommandDetail.pipeline_logs.length > 0 && (
                  <div className="drawer-section">
                    <div className="spec-label">
                      Pipeline execution trace ({selectedCommandDetail.pipeline_logs.length})
                    </div>
                    <div className="activity-list" style={{ maxHeight: 220 }}>
                      {selectedCommandDetail.pipeline_logs.map((log) => (
                        <div key={log.log_id} className="activity-item">
                          <div className="activity-head">
                            <span className="mono">
                              {log.node_id || "pipeline"} · {log.event_type}
                            </span>
                            <span className={`pill ${statusPillClass(log.status)}`}>
                              {statusLabel(log.status)}
                            </span>
                          </div>
                          <div className="activity-body">{log.message}</div>
                          <span className="sub">{dateLabel(log.created_at)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : null}
          </aside>
        </div>
      )}

      {activeCall && (
        <div
          className={`incoming-call-banner ${activeCall.status === "ringing" ? "ringing" : "active"}`}
          role="region"
          aria-live="assertive"
        >
          <div className="top-banner-left">
            <span className="call-pulse-dot" />
            <div className="top-banner-content">
              <div className="top-banner-head">
                <span className={`pill ${activeCall.status === "ringing" ? "warn" : "ok"}`}>
                  {activeCall.status === "ringing" ? "Incoming WhatsApp Call" : `Live Call · ${webrtcState}`}
                </span>
                <strong className="top-banner-title">
                  {activeCall.client_name} · {activeCall.phone_number}
                </strong>
              </div>
              <div className="top-banner-desc">
                {activeCall.transcripts.length > 0
                  ? `"${activeCall.transcripts[activeCall.transcripts.length - 1].text}"`
                  : activeCall.status === "ringing"
                    ? "Customer is calling the paired Stock AI WhatsApp line. Answer in browser via WebRTC Opus."
                    : "Bidirectional WebRTC Opus (48 kHz) active — Whisper is listening."}
              </div>
            </div>
          </div>
          <div className="top-banner-actions">
            {activeCall.status === "ringing" ? (
              <>
                <button
                  className="btn small primary"
                  type="button"
                  disabled={callBusy}
                  onClick={() => void answerCall(activeCall.call_id)}
                >
                  {callBusy ? "Connecting..." : "Answer"}
                </button>
                <button
                  className="btn small reject"
                  type="button"
                  disabled={callBusy}
                  onClick={() => void rejectCall(activeCall.call_id)}
                >
                  Reject
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn small ghost"
                  type="button"
                  onClick={() => setPage("call")}
                >
                  Open Call Desk
                </button>
                <button
                  className="btn small ghost"
                  type="button"
                  onClick={() => void toggleCallMute(activeCall.call_id, !activeCall.muted)}
                >
                  {activeCall.muted ? "Unmute" : "Mute"}
                </button>
                <button
                  className="btn small reject"
                  type="button"
                  onClick={() => void hangupCall(activeCall.call_id)}
                >
                  Hang up
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {topBanner && (
        <div
          className={`top-order-banner ${topBanner.tone}`}
          role="status"
          aria-live="polite"
        >
          <div className="top-banner-left">
            <span className="top-banner-icon">S</span>
            <div className="top-banner-content">
              <div className="top-banner-head">
                <span className={`pill ${topBanner.tone}`}>
                  {topBanner.badge}
                </span>
                <strong className="top-banner-title">{topBanner.title}</strong>
              </div>
              <div className="top-banner-desc">{topBanner.description}</div>
            </div>
          </div>
          <div className="top-banner-actions">
            {topBanner.commandId && (
              <button
                className="btn small primary"
                type="button"
                onClick={() => {
                  setPage("commands");
                  setFlashCommandId(topBanner.commandId || null);
                  setTopBanner(null);
                }}
              >
                View order
              </button>
            )}
            <button
              className="btn ghost small"
              type="button"
              aria-label="Dismiss notification"
              onClick={() => setTopBanner(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}

      <div
        className={`toast${toastMsg ? " show" : ""}${toastMsg?.bad ? " bad" : ""}`}
      >
        {toastMsg?.text || ""}
      </div>
    </div>
  );
}
