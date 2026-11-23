const TOKEN_KEY = "stockline_admin_token";
const THEME_KEY = "stockline_admin_theme";
const POS_KEY = "stockline_n8n_positions_v2";

const GRAPH_NODES = [
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
    badge: "Docker STT",
    title: "Whisper Turbo",
    stage: "2 · Extraction",
    x: 310,
    y: 150,
    hasIn: true,
    hasOut: true,
    role: "Converts .ogg Opus to 16 kHz mono WAV via ffmpeg and runs compiled /usr/local/bin/whisper-cli with ggml-large-v3-turbo-q5_0.bin (-l fr) primed with catalogue product names.",
    schema: `STTOutput {
  text: string
  wav_path: string
  bin: "/usr/local/bin/whisper-cli"
  model: "/app/models/whisper/ggml-large-v3-turbo-q5_0.bin"
  prompt: catalogue_vocabulary
}`,
    example: {
      text: "J'aimerais aussi avoir 10 kg de tomates grappes, s'il vous plaît.",
      model: "/app/models/whisper/ggml-large-v3-turbo-q5_0.bin",
      returncode: 0,
    },
  },
  {
    id: "ocr.tesseract",
    badge: "Docker OCR",
    title: "Tesseract OCR",
    stage: "2 · Extraction",
    x: 310,
    y: 304,
    hasIn: true,
    hasOut: true,
    role: "Extracts structured text from purchase-order images inside the container using /usr/bin/tesseract (-l eng+fra) and merges it with any WhatsApp caption.",
    schema: `OCROutput {
  text: string
  ocr_raw: string
  caption: string
  bin: "tesseract"
  languages: "eng+fra"
}`,
    example: {
      text: "BON DE COMMANDE YOHANN Merci de livrer 3 Cabillaud 3/5 pour jeudi",
      languages: "eng+fra",
      returncode: 0,
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
      summary: "Modification de la commande C-922a0a99 : 15 kg de Tomates grappe à 2,45 €/kg pour le 24 novembre 2026.",
      order_lines: [{ product_id: "ART-TOM-GR-01", quantity: 15, price: 2.45, delivery_date: "2026-11-24" }],
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

const GRAPH_EDGES = [
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

function loadSavedPositions() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || new URLSearchParams(location.hash.slice(1)).get("token") || "",
  role: "manager",
  page: "dashboard",
  commands: [],
  products: [],
  clients: [],
  managers: [],
  logs: [],
  nodePayloads: {},
  nodeCounts: {},
  selectedNode: "llm.nemotron",
  selectedLogId: null,
  filterBySelectedNode: false,
  nodePositions: loadSavedPositions(),
  zoom: 0.86,
  panX: 14,
  panY: 10,
  selectedClientId: null,
  clientDetail: null,
  wa: { status: "unknown", phone: "", qr_ready: false },
  lastQr: "",
  commandSearch: "",
  commandStatus: "all",
  commandClientType: "all",
  editingProductId: null,
  editingClientId: null,
  editingManager: null,
  sse: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function money(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function quantity(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? String(Number(n.toFixed(3))) : "0";
}

function dateLabel(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function statusPill(status) {
  const normalized = String(status || "new").toLowerCase();
  const label = normalized === "processed" ? "approved" : normalized;
  const cls = normalized === "processed" || normalized === "ok" || normalized === "sent"
    ? "ok"
    : normalized === "rejected" || normalized === "cancelled"
      ? "bad"
      : "warn";
  return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
}

function clientTag(command) {
  const count = Number(command.client_order_count || 1);
  if (count <= 1) return `<span class="pill info">First order</span>`;
  return `<span class="pill">Returning · ${count} orders</span>`;
}

function toast(message, bad = false) {
  const node = $("#toast");
  if (!node) return;
  node.textContent = message;
  node.className = `toast show${bad ? " bad" : ""}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { node.className = "toast"; }, 3800);
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const meta = $('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", theme);
  localStorage.setItem(THEME_KEY, theme);
  const btn = $("#theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "Light mode" : "Dark mode";
}

const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
setTheme(localStorage.getItem(THEME_KEY) || (prefersDark ? "dark" : "light"));

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && path !== "/api/auth/login") {
    state.token = "";
    localStorage.removeItem(TOKEN_KEY);
    stopStream();
    showLogin();
    throw new Error("Session expired. Sign in again.");
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      message = body.detail || body.message || message;
    } catch { /* keep default */ }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function showLogin() {
  $("#login-screen").classList.remove("hidden");
  $("#app-shell").classList.add("hidden");
}

function showApp() {
  $("#login-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
}

function setPage(page) {
  state.page = page;
  $$(".page").forEach((node) => node.classList.toggle("active", node.id === `page-${page}`));
  $$(".nav-item").forEach((node) => node.classList.toggle("active", node.dataset.page === page));
  $("#mobile-nav")?.classList.add("hidden");
  $("#menu-toggle")?.setAttribute("aria-expanded", "false");
  const titles = {
    dashboard: ["Dashboard", "Live orders, decision workflow and catalogue health."],
    commands: ["Commands", "Approve or reject orders with an optional WhatsApp reply to the client."],
    products: ["Products", "Catalogue pricing and available stock used by the ordering agent."],
    clients: ["Clients", "Registered WhatsApp buyers. Click any client to open their order history and statistics."],
    pipeline: ["Pipeline", "Real-time execution canvas from WhatsApp intake to Nemotron 550B and PostgreSQL."],
    settings: ["Settings", "WhatsApp pairing and manager account administration."],
  };
  const [title, subtitle] = titles[page] || titles.dashboard;
  $("#page-title").textContent = title;
  $("#page-subtitle").textContent = subtitle;
  if (page === "settings") refreshWa();
  if (page === "pipeline") refreshPipelineLogs();
}

function applyRole() {
  const isAdmin = state.role === "admin";
  $$(".admin-only").forEach((node) => node.classList.toggle("hidden", !isAdmin));
  $$("#page-products .split-layout, #page-clients .split-layout").forEach((node) =>
    node.classList.toggle("single-col", !isAdmin)
  );
  if (!isAdmin && state.page === "settings") setPage("dashboard");
}

function renderStats() {
  const wa = state.wa || {};
  const pendingOrders = state.commands.filter((c) => String(c.status || "new").toLowerCase() === "new").length;
  const approvedOrders = state.commands.filter((c) => String(c.status || "").toLowerCase() === "processed").length;
  const waLabel = wa.status === "connected"
    ? "Connected"
    : wa.status === "qr_pending"
      ? "Waiting scan"
      : wa.status === "admin only"
        ? "Active"
        : "Disconnected";
  const cards = [
    ["Commands", state.commands.length, `${pendingOrders} pending · ${approvedOrders} approved`],
    ["Registered clients", state.clients.length, "strict WhatsApp allowlist"],
    ["Catalogue products", state.products.length, "active items"],
    ["WhatsApp line", waLabel, wa.phone ? wa.phone.split(":")[0] : (wa.qr_ready ? "QR ready in Settings" : "ready")],
  ];
  $("#stats-grid").innerHTML = cards.map(([label, value, hint]) => `
    <article class="stat-card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
      <div class="hint">${escapeHtml(hint)}</div>
    </article>`).join("");

  const headerPill = $("#wa-header-pill");
  const headerText = $("#wa-pill-text");
  if (headerPill && headerText) {
    headerText.textContent = `WhatsApp · ${waLabel}`;
    headerPill.className = `pill status-link admin-only ${wa.status === "connected" ? "ok" : wa.status === "qr_pending" ? "warn" : "bad"}`;
    if (state.role !== "admin") headerPill.classList.add("hidden");
  }
  const settingsPill = $("#settings-wa-status");
  if (settingsPill) {
    settingsPill.textContent = waLabel;
    settingsPill.className = `pill ${wa.status === "connected" ? "ok" : wa.status === "qr_pending" ? "warn" : "bad"}`;
  }
}

function decisionCellHtml(command) {
  const id = command.command_id || command.id;
  const status = String(command.status || "new").toLowerCase();
  if (status === "new") {
    return `
      <div class="decision-cell">
        <input class="decision-input" data-comment-for="${escapeHtml(id)}" placeholder="Optional WhatsApp comment to client...">
        <div class="row-actions">
          <button class="btn small approve" type="button" data-decide-id="${escapeHtml(id)}" data-approve="true">Approve</button>
          <button class="btn small reject" type="button" data-decide-id="${escapeHtml(id)}" data-approve="false">Reject</button>
        </div>
      </div>`;
  }
  const comment = command.decision_comment ? `“${escapeHtml(command.decision_comment)}”` : "No comment";
  const by = command.decided_by ? `by ${escapeHtml(command.decided_by)}` : "";
  return `<span class="sub">${comment} ${by}</span>`;
}

function commandRows(items, { showActions = true, compact = false } = {}) {
  if (!items.length) return `<p class="empty">No commands recorded yet.</p>`;
  return `<table>
    <thead>
      <tr>
        <th>Command</th>
        <th>Client</th>
        <th>Product</th>
        <th>Qty</th>
        ${compact ? "" : "<th>Unit (€)</th>"}
        <th>Status</th>
        ${compact ? "" : "<th>Received</th>"}
        ${showActions ? "<th>Decision &amp; WhatsApp reply</th>" : ""}
      </tr>
    </thead>
    <tbody>${items.map((command) => {
      const id = command.command_id || command.id;
      return `
      <tr>
        <td>
          <span class="mono">${escapeHtml(id)}</span>
          <span class="sub">${escapeHtml(command.summary || "—")}</span>
        </td>
        <td>
          <div class="client-cell">
            <strong>${escapeHtml(command.client_name || command.client_id)}</strong>
            <span class="sub mono">${escapeHtml(command.client_phone || command.client_id)}</span>
            <div class="client-tags">${clientTag(command)}</div>
          </div>
        </td>
        <td>
          <span>${escapeHtml(command.product_name || command.product_id || "—")}</span>
          <span class="sub mono">${escapeHtml(command.product_id || "")}</span>
        </td>
        <td>${escapeHtml(quantity(command.quantity))}</td>
        ${compact ? "" : `<td>${escapeHtml(money(command.price))}</td>`}
        <td>${statusPill(command.status)}</td>
        ${compact ? "" : `<td>${escapeHtml(dateLabel(command.recorded_at))}</td>`}
        ${showActions ? `<td>${decisionCellHtml(command)}</td>` : ""}
      </tr>`;
    }).join("")}</tbody>
  </table>`;
}

function filteredCommands() {
  const query = state.commandSearch.trim().toLowerCase();
  return state.commands.filter((command) => {
    const matchesStatus = state.commandStatus === "all" || String(command.status || "new").toLowerCase() === state.commandStatus;
    const count = Number(command.client_order_count || 1);
    const matchesClient = state.commandClientType === "all"
      || (state.commandClientType === "new" && count <= 1)
      || (state.commandClientType === "returning" && count > 1);
    const haystack = [
      command.command_id,
      command.client_name,
      command.client_phone,
      command.client_id,
      command.product_id,
      command.product_name,
      command.summary,
      command.decision_comment,
    ].join(" ").toLowerCase();
    return matchesStatus && matchesClient && (!query || haystack.includes(query));
  });
}

function renderCommands() {
  $("#commands-table").innerHTML = commandRows(filteredCommands(), { showActions: true, compact: false });
  $("#dashboard-commands").innerHTML = commandRows(state.commands.slice(0, 8), { showActions: true, compact: true });
}

function renderActivity() {
  const box = $("#dashboard-activity");
  if (!box) return;
  const items = state.logs.slice(0, 12);
  if (!items.length) {
    box.innerHTML = `<p class="empty">No pipeline or decision events yet.</p>`;
    return;
  }
  box.innerHTML = items.map((item) => `
    <div class="activity-item">
      <div class="activity-head">
        <span class="mono">${escapeHtml(item.event_type || item.type || "event")}</span>
        ${statusPill(item.status || "ok")}
      </div>
      <div class="activity-body">${escapeHtml(item.message || "")}</div>
      <span class="sub">${escapeHtml(dateLabel(item.created_at || item.ts))}</span>
    </div>`).join("");
}

function renderProducts() {
  const isAdmin = state.role === "admin";
  $("#product-count").textContent = `${state.products.length} items`;
  $("#products-table").innerHTML = state.products.length ? `<table>
    <thead><tr><th>ID</th><th>Product</th><th>Price (€)</th><th>Stock</th>${isAdmin ? "<th>Actions</th>" : ""}</tr></thead>
    <tbody>${state.products.map((product) => {
      const stk = Number(product.stock || 0);
      const stkBadge = stk <= 0
        ? '<span class="pill bad">Out of stock</span>'
        : stk <= 5
          ? '<span class="pill warn">Low stock</span>'
          : '<span class="pill ok">In stock</span>';
      return `<tr>
      <td class="mono">${escapeHtml(product.product_id)}</td>
      <td>${escapeHtml(product.product_name)}</td>
      <td>${escapeHtml(money(product.price))}</td>
      <td>${escapeHtml(quantity(product.stock))} ${stkBadge}</td>
      ${isAdmin ? `<td>
        <div class="row-actions">
          <button class="btn ghost small" type="button" data-edit-product="${escapeHtml(product.product_id)}">Edit</button>
          <button class="btn ghost small reject" type="button" data-delete-product="${escapeHtml(product.product_id)}">Delete</button>
        </div>
      </td>` : ""}
    </tr>`;
    }).join("")}</tbody>
  </table>` : `<p class="empty">No products in catalogue. Add products so the ordering AI can match items.</p>`;
}

function renderClients() {
  const isAdmin = state.role === "admin";
  $("#client-count").textContent = `${state.clients.length} clients`;
  $("#clients-table").innerHTML = state.clients.length ? `<table>
    <thead><tr><th>ID</th><th>Client</th><th>WhatsApp phone</th><th>Orders</th><th>Total (€)</th><th>Usual item</th>${isAdmin ? "<th>Actions</th>" : ""}</tr></thead>
    <tbody>${state.clients.map((client) => {
      const selected = state.selectedClientId === client.client_id;
      const count = Number(client.order_count || 0);
      return `<tr class="clickable-row${selected ? " selected" : ""}" data-inspect-client="${escapeHtml(client.client_id)}">
        <td class="mono">${escapeHtml(client.client_id)}</td>
        <td>
          <strong>${escapeHtml(client.client_name)}</strong>
          <span class="sub">${count === 0 ? "No order yet" : count === 1 ? "First-time buyer" : `Returning buyer (${count} orders)`}</span>
        </td>
        <td class="mono">${escapeHtml(client.phone_number)}</td>
        <td>${escapeHtml(count)}</td>
        <td>${escapeHtml(money(client.total_spent))}</td>
        <td class="mono">${escapeHtml(client.usual_product || "—")}</td>
        ${isAdmin ? `<td>
          <div class="row-actions">
            <button class="btn ghost small" type="button" data-edit-client="${escapeHtml(client.client_id)}">Edit</button>
            <button class="btn ghost small reject" type="button" data-delete-client="${escapeHtml(client.client_id)}">Delete</button>
          </div>
        </td>` : ""}
      </tr>`;
    }).join("")}</tbody>
  </table>` : `<p class="empty">No clients registered.</p>`;
}

function renderClientInspector() {
  const panel = $("#client-inspector");
  if (!panel) return;
  if (!state.clientDetail) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  const { client, stats, commands } = state.clientDetail;
  $("#inspector-name").textContent = `${client.client_name} (${client.client_id})`;
  $("#inspector-meta").textContent = `WhatsApp ${client.phone_number} · ${stats.order_count === 0 ? "New client (no past orders)" : `${stats.order_count} recorded order(s)`}`;
  const kpis = [
    ["Orders", stats.order_count, stats.order_count <= 1 ? "First-time profile" : "Returning profile"],
    ["Total spent (€)", money(stats.total_spent), `${quantity(stats.total_quantity)} total units`],
    ["Usual product", stats.usual_product || "—", "most recent product ordered"],
    ["Last order", stats.last_order_at ? dateLabel(stats.last_order_at) : "Never", "latest activity"],
  ];
  $("#inspector-kpis").innerHTML = kpis.map(([label, value, hint]) => `
    <article class="stat-card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
      <div class="hint">${escapeHtml(hint)}</div>
    </article>`).join("");

  $("#inspector-orders").innerHTML = commands.length ? `<table>
    <thead><tr><th>Command</th><th>Product</th><th>Qty</th><th>Price (€)</th><th>Status</th><th>Decision comment</th><th>Date</th></tr></thead>
    <tbody>${commands.map((cmd) => `<tr>
      <td><span class="mono">${escapeHtml(cmd.command_id)}</span><span class="sub">${escapeHtml(cmd.summary || "")}</span></td>
      <td>${escapeHtml(cmd.product_name || cmd.product_id)} <span class="sub mono">${escapeHtml(cmd.product_id)}</span></td>
      <td>${escapeHtml(quantity(cmd.quantity))}</td>
      <td>${escapeHtml(money(cmd.price))}</td>
      <td>${statusPill(cmd.status)}</td>
      <td>${escapeHtml(cmd.decision_comment || "—")} ${cmd.decided_by ? `<span class="sub">by ${escapeHtml(cmd.decided_by)}</span>` : ""}</td>
      <td>${escapeHtml(dateLabel(cmd.recorded_at))}</td>
    </tr>`).join("")}</tbody>
  </table>` : `<p class="empty">No orders recorded for this client yet.</p>`;
}

async function openClientInspector(clientId) {
  state.selectedClientId = clientId;
  renderClients();
  try {
    state.clientDetail = await api(`/admin/clients/${encodeURIComponent(clientId)}/detail`);
    renderClientInspector();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderUsers() {
  const items = state.managers || [];
  $("#manager-count").textContent = `${items.length} managers`;
  $("#managers-table").innerHTML = items.length ? `<table>
    <thead><tr><th>Username</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
    <tbody>${items.map((manager) => `<tr>
      <td class="mono">${escapeHtml(manager.username)}</td>
      <td>${manager.is_active ? '<span class="pill ok">active</span>' : '<span class="pill bad">disabled</span>'}</td>
      <td>${escapeHtml(dateLabel(manager.created_at))}</td>
      <td>
        <div class="row-actions">
          <button class="btn ghost small" type="button" data-edit-manager="${escapeHtml(manager.username)}">Edit</button>
          <button class="btn ghost small" type="button" data-toggle-manager="${escapeHtml(manager.username)}" data-next-active="${!manager.is_active}">${manager.is_active ? "Disable" : "Enable"}</button>
          <button class="btn ghost small reject" type="button" data-delete-manager="${escapeHtml(manager.username)}">Delete</button>
        </div>
      </td>
    </tr>`).join("")}</tbody>
  </table>` : `<p class="empty">No managers created yet. Only the root admin account is active.</p>`;
}

function getNodePos(nodeDef) {
  const saved = state.nodePositions[nodeDef.id];
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    return { x: saved.x, y: saved.y };
  }
  return { x: nodeDef.x, y: nodeDef.y };
}

function saveNodePositions() {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(state.nodePositions));
  } catch { /* ignore */ }
}

function applyWorldTransform() {
  const world = $("#n8n-world");
  if (world) {
    world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  }
  const label = $("#n8n-zoom-label");
  if (label) label.textContent = `${Math.round(state.zoom * 100)}%`;
}

function renderGraphEdges() {
  const svg = $("#n8n-edges");
  if (!svg) return;
  const posMap = {};
  for (const def of GRAPH_NODES) {
    posMap[def.id] = getNodePos(def);
  }
  const NODE_W = 214;
  const NODE_H = 82;
  const paths = GRAPH_EDGES.map(([fromId, toId]) => {
    const from = posMap[fromId];
    const to = posMap[toId];
    if (!from || !to) return "";
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const dx = Math.max(54, Math.abs(x2 - x1) * 0.48);
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    const hot = Boolean(state.nodePayloads[fromId] && state.nodePayloads[toId]);
    return `<path class="n8n-edge-base" d="${d}"></path><path class="n8n-edge-flow${hot ? " hot" : ""}" d="${d}"></path>`;
  }).join("");
  svg.innerHTML = paths;
}

function selectGraphNode(nodeId, logEntry = null) {
  state.selectedNode = nodeId;
  const def = GRAPH_NODES.find((n) => n.id === nodeId) || GRAPH_NODES[0];
  $$(".n8n-node").forEach((el) => el.classList.toggle("selected", el.dataset.node === def.id));

  $("#spec-node-title").textContent = `${def.title} (${def.id})`;
  $("#spec-node-role").textContent = def.role;
  $("#spec-node-stage").textContent = def.stage;
  $("#spec-node-schema").textContent = def.schema;
  $("#spec-node-example").textContent = JSON.stringify(def.example, null, 2);

  const count = state.nodeCounts[def.id] || 0;
  const runBadge = $("#node-run-badge");
  if (runBadge) {
    runBadge.textContent = `${count} run${count === 1 ? "" : "s"}`;
    runBadge.className = `pill ${count > 0 ? "ok" : "muted"}`;
  }

  const live = logEntry || state.nodePayloads[def.id];
  if (live) {
    inspectPayload(
      `${def.title} · ${live.event_type || live.type || "event"}`,
      `Captured at ${dateLabel(live.created_at || live.ts)} · status: ${live.status || "ok"}`,
      live.payload || live
    );
  } else {
    inspectPayload(
      `${def.title} · Ready`,
      "No runtime event captured on this node in the current buffer; showing default contract.",
      def.example
    );
  }
  renderEnumLogs();
}

function updateNodeCanvasFromLogs() {
  state.nodePayloads = {};
  state.nodeCounts = {};
  for (const item of [...state.logs].reverse()) {
    const nodeId = item.node_id || item.node;
    if (!nodeId) continue;
    state.nodePayloads[nodeId] = item;
    state.nodeCounts[nodeId] = (state.nodeCounts[nodeId] || 0) + 1;
  }

  const container = $("#n8n-nodes");
  if (!container) return;
  if (!container.children.length) {
    container.innerHTML = GRAPH_NODES.map((def) => {
      const pos = getNodePos(def);
      return `<div class="n8n-node" data-node="${escapeHtml(def.id)}" style="left:${pos.x}px;top:${pos.y}px">
        ${def.hasIn ? '<span class="n8n-port in"></span>' : ""}
        <div class="n8n-node-top">
          <span class="n8n-node-badge">${escapeHtml(def.badge)}</span>
          <span class="n8n-node-runs" data-node-runs="${escapeHtml(def.id)}">0×</span>
        </div>
        <strong>${escapeHtml(def.title)}</strong>
        <span class="n8n-node-meta" data-node-meta="${escapeHtml(def.id)}">${escapeHtml(def.stage)}</span>
        ${def.hasOut ? '<span class="n8n-port out"></span>' : ""}
      </div>`;
    }).join("");
  }

  $$(".n8n-node").forEach((el) => {
    const nodeId = el.dataset.node;
    const def = GRAPH_NODES.find((n) => n.id === nodeId);
    if (def) {
      const pos = getNodePos(def);
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
    }
    const last = state.nodePayloads[nodeId];
    const count = state.nodeCounts[nodeId] || 0;
    const meta = $(`[data-node-meta="${nodeId}"]`);
    const runs = $(`[data-node-runs="${nodeId}"]`);
    if (runs) runs.textContent = `${count}×`;
    el.classList.remove("active-ok", "active-warn", "active-bad");
    el.classList.toggle("selected", state.selectedNode === nodeId);
    if (!last) {
      if (meta && def) meta.textContent = def.stage;
      return;
    }
    const st = String(last.status || "").toLowerCase();
    if (st === "rejected" || st === "cancelled") el.classList.add("active-bad");
    else if (st === "new" || st === "new_client" || st === "received") el.classList.add("active-warn");
    else el.classList.add("active-ok");
    if (meta && last.message) meta.textContent = last.message;
  });

  applyWorldTransform();
  renderGraphEdges();
}

function inspectPayload(title, subtitle, payload) {
  $("#node-inspector-title").textContent = title;
  $("#node-inspector-sub").textContent = subtitle;
  $("#node-inspector-json").textContent = JSON.stringify(payload, null, 2);
}

function renderEnumLogs() {
  const list = $("#pipeline-enum-list");
  if (!list) return;
  const filterBtn = $("#log-filter-node");
  if (filterBtn) {
    filterBtn.textContent = state.filterBySelectedNode && state.selectedNode
      ? `Filter: ${state.selectedNode}`
      : "All nodes";
  }
  const items = state.filterBySelectedNode && state.selectedNode
    ? state.logs.filter((x) => (x.node_id || x.node) === state.selectedNode)
    : state.logs;
  $("#pipeline-log-count").textContent = `${items.length} steps`;
  if (!items.length) {
    list.innerHTML = `<li class="empty">No execution steps recorded for this filter.</li>`;
    return;
  }
  const total = items.length;
  list.innerHTML = items.map((item, idx) => {
    const stepNum = String(total - idx).padStart(2, "0");
    const active = state.selectedLogId === item.log_id;
    return `<li class="enum-log-item${active ? " active" : ""}" data-enum-idx="${idx}">
      <span class="enum-num">#${stepNum}</span>
      <div class="enum-body">
        <div class="enum-head">
          <span class="mono">${escapeHtml(item.node_id || item.node || "pipeline")} · ${escapeHtml(item.event_type || item.type || "event")}</span>
          ${statusPill(item.status || "ok")}
        </div>
        <div class="enum-msg">${escapeHtml(item.message || "")}</div>
        <div class="enum-time">${escapeHtml(dateLabel(item.created_at || item.ts))}${item.phone_number ? ` · ${escapeHtml(item.phone_number)}` : ""}</div>
      </div>
    </li>`;
  }).join("");
}

function renderPipeline() {
  updateNodeCanvasFromLogs();
  selectGraphNode(state.selectedNode || "llm.nemotron");
}

async function refreshPipelineLogs() {
  try {
    const data = await api("/admin/pipeline/logs?limit=120");
    state.logs = data.items || [];
    renderPipeline();
    renderActivity();
  } catch { /* ignore */ }
}

function pulseNode(nodeId, status = "ok") {
  if (!nodeId) return;
  const node = $(`.n8n-node[data-node="${nodeId}"]`);
  if (!node) return;
  const cls = status === "rejected" ? "active-bad" : "active-warn";
  node.classList.add(cls);
  setTimeout(() => renderPipeline(), 1200);
}

function startStream() {
  stopStream();
  if (!state.token) return;
  const source = new EventSource(`/api/commands/stream?token=${encodeURIComponent(state.token)}`);
  state.sse = source;
  source.onopen = () => {
    const pill = $("#sse-indicator");
    const txt = $("#sse-text");
    if (pill) pill.className = "pill ok";
    if (txt) txt.textContent = "Live stream connected";
  };
  source.onerror = () => {
    const pill = $("#sse-indicator");
    const txt = $("#sse-text");
    if (pill) pill.className = "pill warn";
    if (txt) txt.textContent = "Reconnecting stream...";
  };
  source.onmessage = async (ev) => {
    try {
      const event = JSON.parse(ev.data);
      const normalized = {
        log_id: event.log_id || Date.now(),
        created_at: event.created_at || event.ts || new Date().toISOString(),
        event_type: event.type || "event",
        node_id: event.node || "",
        client_id: event.client_id || "",
        phone_number: event.phone_number || "",
        command_id: event.command_id || "",
        actor: event.actor || "",
        status: event.status || "ok",
        message: event.message || "",
        payload: event,
      };
      state.logs = [normalized, ...state.logs.filter((x) => x.log_id !== normalized.log_id)].slice(0, 150);
      pulseNode(normalized.node_id, normalized.status);
      renderPipeline();
      renderActivity();
      inspectPayload(
        `${normalized.node_id || "pipeline"} · ${normalized.event_type}`,
        dateLabel(normalized.created_at),
        normalized.payload
      );
      if (["command.created", "command.modified", "command.cancelled", "command.decided"].includes(normalized.event_type)) {
        const [commands, clients, products] = await Promise.all([
          api("/api/commands?limit=200"),
          api("/admin/clients"),
          api("/admin/products"),
        ]);
        state.commands = commands.items || [];
        state.clients = clients || [];
        state.products = products || [];
        renderStats();
        renderCommands();
        renderClients();
        renderProducts();
        if (state.selectedClientId) openClientInspector(state.selectedClientId);
      }
    } catch { /* ignore malformed event */ }
  };
}

function stopStream() {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
}

function renderWa() {
  if (state.role !== "admin") return;
  const wa = state.wa || {};
  const waLabel = wa.status === "connected" ? "Connected" : wa.status === "qr_pending" ? "Waiting for QR scan" : wa.status === "unavailable" ? "Service unavailable" : "Disconnected";
  $("#settings-wa-state").textContent = waLabel;
  $("#settings-wa-phone").textContent = wa.phone ? wa.phone.split(":")[0] : "Not linked";

  const box = $("#wa-qr");
  if (!box) return;
  if (wa.status === "connected") {
    state.lastQr = "";
    box.innerHTML = `<p class="empty">WhatsApp is connected${wa.phone ? ` (${escapeHtml(wa.phone.split(":")[0])})` : ""}.</p>`;
    return;
  }
  if (!wa.qr_ready) {
    state.lastQr = "";
    box.innerHTML = `<p class="empty">No active QR code. Click “Generate / refresh QR”.</p>`;
    return;
  }
  api("/admin/whatsapp/qr").then((data) => {
    if (!data?.qr) return;
    if (state.lastQr === data.qr && box.querySelector("img")) return;
    state.lastQr = data.qr;
    box.innerHTML = `<div class="qr-frame"><img src="${data.qr}" alt="WhatsApp pairing QR code"></div><p class="qr-caption">Scan with WhatsApp Linked devices</p>`;
  }).catch((error) => {
    if (!box.querySelector("img")) box.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  });
}

function resetProductForm() {
  state.editingProductId = null;
  const form = $("#product-form");
  form.reset();
  form.elements.product_id.readOnly = false;
  $("#product-form-title").textContent = "Add product";
  $("#product-submit").textContent = "Save product";
  $("#product-cancel").classList.add("hidden");
}

function resetClientForm() {
  state.editingClientId = null;
  const form = $("#client-form");
  form.reset();
  form.elements.client_id.readOnly = false;
  $("#client-form-title").textContent = "Add client";
  $("#client-submit").textContent = "Save client";
  $("#client-cancel").classList.add("hidden");
}

function resetManagerForm() {
  state.editingManager = null;
  const form = $("#manager-form");
  form.reset();
  form.elements.username.readOnly = false;
  form.elements.password.required = true;
  $("#manager-form-title").textContent = "Create manager";
  $("#manager-submit").textContent = "Save manager";
  $("#manager-cancel").classList.add("hidden");
}

async function refreshWa() {
  if (state.role !== "admin") return;
  try {
    state.wa = await api("/admin/whatsapp/status");
  } catch {
    state.wa = { status: "unavailable", phone: "", qr_ready: false };
  }
  renderStats();
  renderWa();
}

async function loadAll() {
  const me = await api("/api/auth/me");
  state.role = me.role || "manager";
  $("#user-badge").textContent = `${me.username} · ${state.role}`;
  const [commands, products, clients, pipe] = await Promise.all([
    api("/api/commands?limit=200"),
    api("/admin/products"),
    api("/admin/clients"),
    api("/admin/pipeline/logs?limit=120"),
  ]);
  state.commands = commands.items || [];
  state.products = products || [];
  state.clients = clients || [];
  state.logs = pipe.items || [];
  if (state.role === "admin") {
    const [wa, managers] = await Promise.all([
      api("/admin/whatsapp/status"),
      api("/admin/managers"),
    ]);
    state.wa = wa;
    state.managers = managers || [];
  } else {
    state.wa = { status: "admin only", phone: "", qr_ready: false };
    state.managers = [];
  }
  applyRole();
  renderStats();
  renderCommands();
  renderActivity();
  renderProducts();
  renderClients();
  renderClientInspector();
  renderUsers();
  renderPipeline();
  renderWa();
  startStream();
}

async function login(event) {
  event.preventDefault();
  const username = $("#login-user").value.trim();
  const password = $("#login-pass").value;
  const button = $("#login-form button[type=submit]");
  button.disabled = true;
  $("#login-error").textContent = "";
  try {
    const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, state.token);
    showApp();
    await loadAll();
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function bindGraphCanvasInteraction() {
  const viewport = $("#n8n-viewport");
  if (!viewport) return;
  let dragMode = null;
  let dragNodeId = null;
  let startX = 0;
  let startY = 0;
  let origX = 0;
  let origY = 0;
  let moved = false;

  viewport.addEventListener("pointerdown", (event) => {
    const nodeEl = event.target.closest(".n8n-node");
    startX = event.clientX;
    startY = event.clientY;
    moved = false;
    if (nodeEl) {
      dragMode = "node";
      dragNodeId = nodeEl.dataset.node;
      const def = GRAPH_NODES.find((n) => n.id === dragNodeId);
      const pos = def ? getNodePos(def) : { x: 0, y: 0 };
      origX = pos.x;
      origY = pos.y;
      nodeEl.setPointerCapture(event.pointerId);
    } else {
      dragMode = "pan";
      origX = state.panX;
      origY = state.panY;
      viewport.classList.add("panning");
      viewport.setPointerCapture(event.pointerId);
    }
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!dragMode) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    if (dragMode === "node" && dragNodeId) {
      const nx = Math.max(8, Math.round(origX + dx / state.zoom));
      const ny = Math.max(8, Math.round(origY + dy / state.zoom));
      state.nodePositions[dragNodeId] = { x: nx, y: ny };
      const nodeEl = $(`.n8n-node[data-node="${dragNodeId}"]`);
      if (nodeEl) {
        nodeEl.style.left = `${nx}px`;
        nodeEl.style.top = `${ny}px`;
      }
      renderGraphEdges();
    } else if (dragMode === "pan") {
      state.panX = Math.round(origX + dx);
      state.panY = Math.round(origY + dy);
      applyWorldTransform();
    }
  });

  const endDrag = () => {
    if (dragMode === "node" && dragNodeId) {
      saveNodePositions();
      if (!moved) selectGraphNode(dragNodeId);
    }
    dragMode = null;
    dragNodeId = null;
    viewport.classList.remove("panning");
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  $("#n8n-zoom-in")?.addEventListener("click", () => {
    state.zoom = Math.min(1.35, Number((state.zoom + 0.1).toFixed(2)));
    applyWorldTransform();
  });
  $("#n8n-zoom-out")?.addEventListener("click", () => {
    state.zoom = Math.max(0.55, Number((state.zoom - 0.1).toFixed(2)));
    applyWorldTransform();
  });
  $("#n8n-fit")?.addEventListener("click", () => {
    state.nodePositions = {};
    saveNodePositions();
    state.zoom = 0.86;
    state.panX = 14;
    state.panY = 10;
    updateNodeCanvasFromLogs();
    toast("Graph layout tidied");
  });
  $("#log-filter-node")?.addEventListener("click", () => {
    state.filterBySelectedNode = !state.filterBySelectedNode;
    renderEnumLogs();
  });
}
function bindEvents() {
  bindGraphCanvasInteraction();
  $("#login-form").addEventListener("submit", login);
  $("#logout").addEventListener("click", () => {
    state.token = "";
    localStorage.removeItem(TOKEN_KEY);
    stopStream();
    showLogin();
  });
  $("#theme-toggle").addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  $("#menu-toggle").addEventListener("click", () => {
    const nav = $("#mobile-nav");
    const open = nav.classList.toggle("hidden") === false;
    $("#menu-toggle").setAttribute("aria-expanded", String(open));
  });
  $("#inspector-close").addEventListener("click", () => {
    state.selectedClientId = null;
    state.clientDetail = null;
    renderClients();
    renderClientInspector();
  });
  $("#pipeline-refresh").addEventListener("click", () => {
    refreshPipelineLogs();
    toast("Pipeline logs refreshed");
  });

  document.addEventListener("click", async (event) => {
    const navBtn = event.target.closest(".nav-item");
    if (navBtn?.dataset.page) {
      setPage(navBtn.dataset.page);
      return;
    }
    const goTarget = event.target.closest("[data-go]");
    if (goTarget) {
      event.preventDefault();
      setPage(goTarget.dataset.go);
      return;
    }
    const nodeBtn = event.target.closest(".n8n-node");
    if (nodeBtn) {
      selectGraphNode(nodeBtn.dataset.node);
      return;
    }
    const enumRow = event.target.closest("[data-enum-idx]");
    if (enumRow) {
      const items = state.filterBySelectedNode && state.selectedNode
        ? state.logs.filter((x) => (x.node_id || x.node) === state.selectedNode)
        : state.logs;
      const item = items[Number(enumRow.dataset.enumIdx)];
      if (item) {
        state.selectedLogId = item.log_id;
        selectGraphNode(item.node_id || item.node || state.selectedNode || "llm.nemotron", item);
      }
      return;
    }
    const decideBtn = event.target.closest("[data-decide-id]");
    if (decideBtn) {
      const id = decideBtn.dataset.decideId;
      const approve = decideBtn.dataset.approve === "true";
      const cell = decideBtn.closest(".decision-cell");
      const commentInput = cell?.querySelector(`[data-comment-for="${CSS.escape(id)}"]`);
      const comment = commentInput ? commentInput.value.trim() : "";
      decideBtn.disabled = true;
      try {
        const res = await api(`/api/commands/${encodeURIComponent(id)}/approve`, {
          method: "POST",
          body: JSON.stringify({ approve, comment }),
        });
        const [commands, clients, products] = await Promise.all([
          api("/api/commands?limit=200"),
          api("/admin/clients"),
          api("/admin/products"),
        ]);
        state.commands = commands.items || [];
        state.clients = clients || [];
        state.products = products || [];
        renderStats();
        renderCommands();
        renderClients();
        renderProducts();
        if (state.selectedClientId) openClientInspector(state.selectedClientId);
        toast(
          `${approve ? "Approved" : "Rejected"}${res.wa_sent ? " · WhatsApp notification sent" : ""}`
        );
      } catch (error) {
        decideBtn.disabled = false;
        toast(error.message, true);
      }
      return;
    }
    const editProd = event.target.closest("[data-edit-product]");
    if (editProd) {
      const p = state.products.find((item) => item.product_id === editProd.dataset.editProduct);
      if (!p) return;
      state.editingProductId = p.product_id;
      const form = $("#product-form");
      form.elements.product_id.value = p.product_id;
      form.elements.product_id.readOnly = true;
      form.elements.product_name.value = p.product_name;
      form.elements.price.value = p.price;
      form.elements.stock.value = p.stock;
      $("#product-form-title").textContent = `Edit ${p.product_id}`;
      $("#product-submit").textContent = "Save changes";
      $("#product-cancel").classList.remove("hidden");
      return;
    }
    const delProd = event.target.closest("[data-delete-product]");
    if (delProd) {
      const id = delProd.dataset.deleteProduct;
      try {
        await api(`/admin/products/${encodeURIComponent(id)}`, { method: "DELETE" });
        state.products = await api("/admin/products");
        renderStats();
        renderProducts();
        toast(`Product ${id} deleted`);
      } catch (error) {
        toast(error.message, true);
      }
      return;
    }
    const editCli = event.target.closest("[data-edit-client]");
    if (editCli) {
      event.stopPropagation();
      const c = state.clients.find((item) => item.client_id === editCli.dataset.editClient);
      if (!c) return;
      state.editingClientId = c.client_id;
      const form = $("#client-form");
      form.elements.client_id.value = c.client_id;
      form.elements.client_id.readOnly = true;
      form.elements.phone_number.value = c.phone_number;
      form.elements.client_name.value = c.client_name;
      $("#client-form-title").textContent = `Edit ${c.client_id}`;
      $("#client-submit").textContent = "Save changes";
      $("#client-cancel").classList.remove("hidden");
      return;
    }
    const delCli = event.target.closest("[data-delete-client]");
    if (delCli) {
      event.stopPropagation();
      const id = delCli.dataset.deleteClient;
      try {
        await api(`/admin/clients/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (state.selectedClientId === id) {
          state.selectedClientId = null;
          state.clientDetail = null;
          renderClientInspector();
        }
        state.clients = await api("/admin/clients");
        renderStats();
        renderClients();
        toast(`Client ${id} deleted`);
      } catch (error) {
        toast(error.message, true);
      }
      return;
    }
    const inspectCli = event.target.closest("[data-inspect-client]");
    if (inspectCli) {
      openClientInspector(inspectCli.dataset.inspectClient);
      return;
    }
    const editMgr = event.target.closest("[data-edit-manager]");
    if (editMgr) {
      const username = editMgr.dataset.editManager;
      state.editingManager = username;
      const form = $("#manager-form");
      form.elements.username.value = username;
      form.elements.username.readOnly = true;
      form.elements.password.value = "";
      form.elements.password.required = false;
      $("#manager-form-title").textContent = `Update ${username}`;
      $("#manager-submit").textContent = "Save changes";
      $("#manager-cancel").classList.remove("hidden");
      return;
    }
    const toggleMgr = event.target.closest("[data-toggle-manager]");
    if (toggleMgr) {
      const username = toggleMgr.dataset.toggleManager;
      const nextActive = toggleMgr.dataset.nextActive === "true";
      try {
        await api(`/admin/managers/${encodeURIComponent(username)}`, {
          method: "PUT",
          body: JSON.stringify({ is_active: nextActive }),
        });
        state.managers = await api("/admin/managers");
        renderUsers();
        toast(nextActive ? `${username} enabled` : `${username} disabled`);
      } catch (error) {
        toast(error.message, true);
      }
      return;
    }
    const delMgr = event.target.closest("[data-delete-manager]");
    if (delMgr) {
      const username = delMgr.dataset.deleteManager;
      try {
        await api(`/admin/managers/${encodeURIComponent(username)}`, { method: "DELETE" });
        if (state.editingManager === username) resetManagerForm();
        state.managers = await api("/admin/managers");
        renderUsers();
        toast(`Manager ${username} deleted`);
      } catch (error) {
        toast(error.message, true);
      }
    }
  });

  $("#product-cancel").addEventListener("click", resetProductForm);
  $("#client-cancel").addEventListener("click", resetClientForm);
  $("#manager-cancel").addEventListener("click", resetManagerForm);

  $("#command-search").addEventListener("input", (event) => {
    state.commandSearch = event.target.value;
    renderCommands();
  });
  $("#command-status").addEventListener("change", (event) => {
    state.commandStatus = event.target.value;
    renderCommands();
  });
  $("#command-client-type").addEventListener("change", (event) => {
    state.commandClientType = event.target.value;
    renderCommands();
  });
  $("#refresh-commands").addEventListener("click", async () => {
    try {
      const data = await api("/api/commands?limit=200");
      state.commands = data.items || [];
      renderStats();
      renderCommands();
      toast("Commands refreshed");
    } catch (error) { toast(error.message, true); }
  });

  $("#product-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api("/admin/products", {
        method: "POST",
        body: JSON.stringify({
          product_id: form.get("product_id"),
          product_name: form.get("product_name"),
          price: Number(form.get("price")),
          stock: Number(form.get("stock")),
        }),
      });
      resetProductForm();
      state.products = await api("/admin/products");
      renderStats();
      renderProducts();
      toast("Product saved");
    } catch (error) { toast(error.message, true); }
  });

  $("#client-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const cid = String(form.get("client_id") || "").trim();
      await api("/admin/clients", {
        method: "POST",
        body: JSON.stringify({
          client_id: cid,
          phone_number: form.get("phone_number"),
          client_name: form.get("client_name"),
        }),
      });
      resetClientForm();
      state.clients = await api("/admin/clients");
      renderStats();
      renderClients();
      if (state.selectedClientId === cid) openClientInspector(cid);
      toast("Client saved");
    } catch (error) { toast(error.message, true); }
  });

  $("#manager-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const username = String(form.get("username") || "").trim();
    const password = String(form.get("password") || "");
    try {
      if (state.editingManager) {
        await api(`/admin/managers/${encodeURIComponent(state.editingManager)}`, {
          method: "PUT",
          body: JSON.stringify(password ? { password } : {}),
        });
      } else {
        await api("/admin/managers", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        });
      }
      resetManagerForm();
      state.managers = await api("/admin/managers");
      renderUsers();
      toast("Manager saved");
    } catch (error) { toast(error.message, true); }
  });

  $("#wa-connect").addEventListener("click", async () => {
    try {
      await api("/admin/whatsapp/connect", { method: "POST" });
      toast("QR refresh requested");
      setTimeout(refreshWa, 1000);
      setTimeout(refreshWa, 3000);
    } catch (error) { toast(error.message, true); }
  });
  $("#wa-disconnect").addEventListener("click", async () => {
    try {
      await api("/admin/whatsapp/disconnect", { method: "POST" });
      state.lastQr = "";
      toast("WhatsApp disconnected");
      refreshWa();
    } catch (error) { toast(error.message, true); }
  });
}

async function boot() {
  bindEvents();
  if (!state.token) {
    showLogin();
    return;
  }
  showApp();
  try {
    await loadAll();
  } catch (error) {
    toast(error.message, true);
    if (!state.token) showLogin();
  }
  if (state.role === "admin") setInterval(() => refreshWa().catch(() => {}), 6000);
  setInterval(async () => {
    if (!state.token) return;
    try {
      const data = await api("/api/commands?limit=200");
      state.commands = data.items || [];
      renderStats();
      renderCommands();
    } catch { /* silent refresh */ }
  }, 15000);
}

boot();
