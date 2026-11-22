import type {
  ClientStats,
  Command,
  Paginated,
  Product,
  Purchase,
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
    const payload = await request<unknown>("/api/commands");
    return extractItems<Command>(payload);
  },

  getCommand: (id: string) =>
    request<Command>(`/api/commands/${encodeURIComponent(id)}`),

  approveCommand: (id: string, approve: boolean) =>
    request<Command>(`/api/commands/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ approve }),
    }),

  getClientStats: (id: string) =>
    request<ClientStats>(`/api/clients/${encodeURIComponent(id)}/stats`),

  getProducts: async (): Promise<Product[]> => {
    const payload = await request<unknown>("/api/products");
    return extractItems<Product>(payload);
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
    request<{ token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  me: () => request<{ username: string }>("/api/auth/me"),

  createCall: () => request<{ call_id: string }>("/api/calls", { method: "POST" }),
};

export type { Paginated };
