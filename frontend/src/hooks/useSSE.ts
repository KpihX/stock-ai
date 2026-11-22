import { useEffect, useRef, useState } from "react";

export type SSEStatus = "connecting" | "open" | "closed";

export function useSSE<T>(url: string, onMessage: (data: T) => void): SSEStatus {
  const [status, setStatus] = useState<SSEStatus>("connecting");
  const handlerRef = useRef(onMessage);

  useEffect(() => {
    handlerRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: number | undefined;
    let stopped = false;

    const connect = () => {
      setStatus("connecting");
      source = new EventSource(url);

      source.onopen = () => {
        setStatus("open");
      };

      source.onmessage = (event: MessageEvent<string>) => {
        try {
          handlerRef.current(JSON.parse(event.data) as T);
        } catch {
          // Ignore malformed payloads and keep the stream alive.
        }
      };

      source.onerror = () => {
        setStatus("closed");
        source?.close();
        source = null;
        if (!stopped) {
          timer = window.setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      stopped = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      source?.close();
      source = null;
    };
  }, [url]);

  return status;
}
