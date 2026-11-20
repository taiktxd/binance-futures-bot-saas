import { useEffect, useState } from 'react';
import type { MarketTick } from '../lib/api';

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? '';

export function useMarketStream() {
  const [ticks, setTicks] = useState<Record<string, MarketTick>>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!WS_URL) return;

    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let backoffMs = 1500;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        setConnected(true);
        backoffMs = 1500;
      };

      ws.onmessage = (event) => {
        try {
          const tick = JSON.parse(event.data) as MarketTick;
          if (tick.symbol) {
            setTicks((prev) => ({ ...prev, [tick.symbol]: tick }));
          }
        } catch {
          // Ignore malformed websocket frames
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!disposed) {
          reconnectTimer = window.setTimeout(() => {
            backoffMs = Math.min(backoffMs * 2, 30000);
            connect();
          }, backoffMs);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      ws?.close();
    };
  }, []);

  return { ticks, connected };
}
