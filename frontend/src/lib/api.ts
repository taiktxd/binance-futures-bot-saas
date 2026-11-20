const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export function getAuthToken(): string | null {
  return localStorage.getItem('qc_token');
}

export function setAuthToken(token: string | null): void {
  if (token) {
    localStorage.setItem('qc_token', token);
  } else {
    localStorage.removeItem('qc_token');
  }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!API_BASE) {
    throw new Error('VITE_API_URL is not configured in environment variables');
  }

  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const msg =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return parsed as T;
}

export interface UserProfile {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN';
  credit_balance: string;
  cumulative_net_pnl: string;
  high_water_mark: string;
  is_active: boolean;
  created_at: string;
}

export interface MaskedApiKey {
  id: string;
  label: string;
  environment: 'TESTNET' | 'LIVE';
  api_key_masked: string;
  can_trade_futures: boolean;
  can_withdraw: boolean;
  ip_restricted: boolean;
  is_active: boolean;
  last_verified_at: string | null;
}

export interface BotConfig {
  id: string;
  api_key_id: string;
  symbol: 'BTCUSDT' | 'ETHUSDT' | 'XAUUSDT' | 'PAXGUSDT';
  strategy: 'TREND_EMA_RSI_ATR' | 'GRID_FUTURES_NEUTRAL';
  margin_type: 'ISOLATED' | 'CROSSED';
  leverage: number;
  order_margin_usdt: string;
  max_open_positions: number;
  sl_atr_multiplier: string;
  tp_atr_multiplier: string;
  status: 'STOPPED' | 'RUNNING' | 'STOP_NEW_ENTRIES' | 'ERROR';
  last_error: string | null;
}

export interface PositionItem {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  margin_type: 'ISOLATED' | 'CROSSED';
  leverage: number;
  entry_price: string;
  quantity: string;
  stop_loss_price: string;
  take_profit_price: string;
  unrealized_pnl: string;
  opened_at: string;
}

export interface TradeItem {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entry_price: string;
  exit_price: string;
  quantity: string;
  realized_pnl: string;
  hwm_fee_charged: string;
  close_reason: string;
  executed_at: string;
}

export interface CreditTxItem {
  id: string;
  tx_type: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  hwm_before: string | null;
  hwm_after: string | null;
  note: string | null;
  created_at: string;
}

export interface MarketTick {
  symbol: string;
  mark_price: string;
  change_pct_24h: string;
  event_time_ms: number;
}
