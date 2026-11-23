export type CommandStatus = "new" | "pending" | "processed" | "rejected" | "cancelled";

export interface OrderLine {
  command_id?: string;
  article_id?: string;
  article_name?: string;
  quantity: number;
  daily_price?: number;
  price?: number;
  product_id?: string;
}

export interface Command {
  id?: string;
  command_id: string;
  recorded_at: string;
  client_id: string;
  client_name?: string;
  client_phone?: string;
  phone_number?: string;
  client_order_count?: number;
  delivery_date?: string;
  product_id?: string;
  product_name?: string;
  price?: number;
  quantity?: number;
  status?: CommandStatus;
  summary?: string;
  decision_comment?: string;
  decided_by?: string;
  decided_at?: string | null;
  approved?: boolean | null;
  order_lines?: OrderLine[];
  source_channel?: string;
  source_call_id?: string;
  source_evenement_id?: string;
  source_raw_text?: string;
  source_metadata?: Record<string, unknown>;
}

export interface CommandDetail {
  command: Command;
  order_lines: OrderLine[];
  normalized_input?: Record<string, unknown> | null;
  call_session?: IncomingCallState | null;
  pipeline_logs: PipelineLogItem[];
}

export interface Product {
  product_id: string;
  product_name?: string;
  article_id?: string;
  article_name?: string;
  price: number;
  stock: number;
}

export interface ClientAccount {
  client_id: string;
  client_name: string;
  phone_number: string;
  order_count?: number;
  total_spent?: number;
  last_order_at?: string | null;
  usual_product?: string;
}

export interface ClientDetail {
  client: { client_id: string; client_name: string; phone_number: string };
  stats: {
    client_id: string;
    order_count: number;
    total_spent: number;
    total_quantity: number;
    last_order_at: string | null;
    usual_product: string;
  };
  commands: Command[];
}

export interface ManagerAccount {
  username: string;
  is_active: boolean;
  created_at: string;
}

export interface WaStatus {
  status: string;
  phone: string;
  qr_ready: boolean;
}

export interface PipelineLogItem {
  log_id: number;
  created_at: string;
  event_type: string;
  node_id: string;
  client_id: string;
  phone_number: string;
  command_id: string;
  actor: string;
  status: string;
  message: string;
  payload: Record<string, unknown>;
}

export interface Purchase {
  id: string;
  command_id?: string;
  product_id: string;
  article_name?: string;
  client_id?: string;
  client_name?: string;
  quantity: number;
  price: number;
  recorded_at?: string;
  approved?: boolean | null;
}

export interface ClientStats {
  client_id: string;
  client_name?: string;
  phone_number?: string;
  command_count: number;
  total_spent: number;
}

export interface CallTranscriptEntry {
  id: string;
  seq?: number;
  speaker: "client" | "manager" | "system" | "assistant";
  text: string;
  duration_ms?: number;
  ts: string;
}

export interface IncomingCallState {
  call_id: string;
  phone_number: string;
  client_id: string;
  client_name: string;
  known_client: boolean;
  status: "ringing" | "active" | "ended" | "rejected";
  mode: string;
  started_at: string;
  ended_at?: string | null;
  reason?: string;
  muted?: boolean;
  committed: boolean;
  command_id?: string;
  transcripts: CallTranscriptEntry[];
  linked_commands?: Command[];
  stats?: Record<string, unknown>;
}

export interface CallConfig {
  provider: string;
  sample_rate: number;
  webrtc_rate: number;
  ice_servers: RTCIceServer[];
}

export interface Paginated<T> {
  items: T[];
  total?: number;
  page?: number;
  size?: number;
}
