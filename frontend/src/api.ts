import type {
  CallConfig,
  ClientAccount,
  ClientDetail,
  ClientStats,
  Command,
  IncomingCallState,
  ManagerAccount,
  Paginated,
  PipelineLogItem,
  Product,
  Purchase,
  WaStatus,
} from "./types";

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://localhost:8000").replace(/\/$/, "");
const TOKEN_KEY = "stockline_token";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Network error";
    throw new ApiError(0, message);
  }

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: unknown; message?: unknown };
      if (typeof body.detail === "string") {
        message = body.detail;
      } else if (typeof body.message === "string") {
        message = body.message;
      }
    } catch {
      // Keep the default message when the body is not JSON.
    }
    if (response.status === 401) {
      clearToken();
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

function extractItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const keys = ["items", "results", "data", "commands", "purchases", "products"];
    for (const key of keys) {
      if (Array.isArray(record[key])) {
        return record[key] as T[];
      }
    }
  }
  return [];
}

export function streamUrl(): string {
  const url = `${BASE_URL}/api/commands/stream`;
  const token = getToken();
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

export function callSocketUrl(callId: string): string {
  const wsBase = BASE_URL.replace(/^http/, "ws");
  return `${wsBase}/ws/call/${encodeURIComponent(callId)}`;
}

export const api = {
  health: () => request<{ status: string }>("/health"),

  getCommands: async (): Promise<Command[]> => {
    const payload = await request<unknown>("/api/commands?limit=200");
    return extractItems<Command>(payload);
  },

  getCommand: (id: string) =>
    request<Command>(`/api/commands/${encodeURIComponent(id)}`),

  approveCommand: (id: string, approve: boolean, comment = "") =>
    request<{
      command_id: string;
      status: string;
      comment: string;
      decided_by: string;
      wa_sent: boolean;
      new_stock?: number | null;
    }>(`/api/commands/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ approve, comment }),
    }),

  getClientStats: (id: string) =>
    request<ClientStats>(`/api/clients/${encodeURIComponent(id)}/stats`),

  getProducts: async (): Promise<Product[]> => {
    const payload = await request<unknown>("/admin/products");
    return extractItems<Product>(payload);
  },

  saveProduct: (product: {
    product_id: string;
    product_name: string;
    price: number;
    stock: number;
  }) =>
    request<{ status: string }>("/admin/products", {
      method: "POST",
      body: JSON.stringify(product),
    }),

  deleteProduct: (id: string) =>
    request<{ status: string }>(`/admin/products/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  getClients: async (): Promise<ClientAccount[]> => {
    const payload = await request<unknown>("/admin/clients");
    return extractItems<ClientAccount>(payload);
  },

  getClientDetail: (id: string) =>
    request<ClientDetail>(`/admin/clients/${encodeURIComponent(id)}/detail`),

  saveClient: (client: {
    client_id: string;
    phone_number: string;
    client_name: string;
  }) =>
    request<{ status: string }>("/admin/clients", {
      method: "POST",
      body: JSON.stringify(client),
    }),

  deleteClient: (id: string) =>
    request<{ status: string }>(`/admin/clients/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  getManagers: async (): Promise<ManagerAccount[]> => {
    const payload = await request<unknown>("/admin/managers");
    return extractItems<ManagerAccount>(payload);
  },

  createManager: (payload: { username: string; password: string }) =>
    request<{ status: string }>("/admin/managers", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateManager: (
    username: string,
    payload: { password?: string; is_active?: boolean },
  ) =>
    request<{ status: string }>(
      `/admin/managers/${encodeURIComponent(username)}`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
      },
    ),

  deleteManager: (username: string) =>
    request<{ status: string }>(
      `/admin/managers/${encodeURIComponent(username)}`,
      {
        method: "DELETE",
      },
    ),

  waStatus: () => request<WaStatus>("/admin/whatsapp/status"),

  waQr: () => request<{ qr: string }>("/admin/whatsapp/qr"),

  waConnect: () =>
    request<{ status: string }>("/admin/whatsapp/connect", { method: "POST" }),

  waDisconnect: () =>
    request<{ status: string }>("/admin/whatsapp/disconnect", {
      method: "POST",
    }),

  getPipelineLogs: async (limit = 120): Promise<PipelineLogItem[]> => {
    const payload = await request<{ items?: PipelineLogItem[] }>(
      `/admin/pipeline/logs?limit=${limit}`,
    );
    return payload?.items || [];
  },

  getPurchases: async (): Promise<Purchase[]> => {
    const payload = await request<unknown>("/api/purchases");
    return extractItems<Purchase>(payload);
  },

  approvePurchase: (id: string, approve: boolean) =>
    request<Purchase>(`/api/purchases/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ approve }),
    }),

  login: (username: string, password: string) =>
    request<{ token: string; role?: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  me: () => request<{ username: string; role?: string }>("/api/auth/me"),

  createCall: () => request<{ call_id: string }>("/api/calls", { method: "POST" }),

  getCallConfig: () => request<CallConfig>("/api/calls/config"),

  getActiveCalls: () =>
    request<{ items: IncomingCallState[]; recent: IncomingCallState[] }>(
      "/api/calls/active",
    ),

  acceptCall: (callId: string, sdpOffer: string) =>
    request<{
      call_id: string;
      status: string;
      sdp_answer: string;
      mode: string;
    }>(`/api/calls/${encodeURIComponent(callId)}/accept`, {
      method: "POST",
      body: JSON.stringify({ sdp_offer: sdpOffer }),
    }),

  rejectCall: (callId: string, reason = "declined") =>
    request<{ call_id: string; status: string }>(
      `/api/calls/${encodeURIComponent(callId)}/reject`,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
      },
    ),

  hangupCall: (callId: string, reason = "completed") =>
    request<{ call_id: string; status: string }>(
      `/api/calls/${encodeURIComponent(callId)}/hangup`,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
      },
    ),

  muteCall: (callId: string, muted: boolean) =>
    request<{ call_id: string; muted: boolean }>(
      `/api/calls/${encodeURIComponent(callId)}/mute`,
      {
        method: "POST",
        body: JSON.stringify({ muted }),
      },
    ),

  commitCall: (callId: string) =>
    request<{ status: string; call_id: string; result?: unknown }>(
      `/api/calls/${encodeURIComponent(callId)}/commit`,
      { method: "POST" },
    ),

  simulateCall: (phone: string, text: string) =>
    request<IncomingCallState & { call_id: string }>("/api/calls/simulate", {
      method: "POST",
      body: JSON.stringify({ phone, text }),
    }),

  injectCallText: (callId: string, text: string) =>
    request<{ call_id: string; samples: number }>(
      `/api/calls/${encodeURIComponent(callId)}/inject-text`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
    ),
};

export type { Paginated };
