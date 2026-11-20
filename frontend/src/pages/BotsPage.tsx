import React, { useEffect, useState } from 'react';
import { AlertCircle, Play, Square } from 'lucide-react';
import { Layout } from '../components/Layout';
import { apiRequest, type BotConfig, type MaskedApiKey } from '../lib/api';

export const BotsPage: React.FC = () => {
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [keys, setKeys] = useState<MaskedApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [apiKeyId, setApiKeyId] = useState('');
  const [symbol, setSymbol] = useState<'BTCUSDT' | 'ETHUSDT' | 'XAUUSDT' | 'PAXGUSDT'>('BTCUSDT');
  const [strategy, setStrategy] = useState<'TREND_EMA_RSI_ATR' | 'GRID_FUTURES_NEUTRAL'>('TREND_EMA_RSI_ATR');
  const [marginType, setMarginType] = useState<'ISOLATED' | 'CROSSED'>('ISOLATED');
  const [leverage, setLeverage] = useState(5);
  const [orderMargin, setOrderMargin] = useState('50');
  const [submitting, setSubmitting] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [botList, keyResp] = await Promise.all([
        apiRequest<BotConfig[]>('/api/v1/bots'),
        apiRequest<{ items: MaskedApiKey[] }>('/api/v1/api-keys'),
      ]);
      setBots(botList);
      setKeys(keyResp.items);
      if (!apiKeyId && keyResp.items.length > 0) {
        setApiKeyId(keyResp.items[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bots');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest('/api/v1/bots', {
        method: 'POST',
        body: JSON.stringify({
          api_key_id: apiKeyId,
          symbol,
          strategy,
          margin_type: marginType,
          leverage: Number(leverage),
          order_margin_usdt: orderMargin,
          sl_atr_multiplier: '1.5',
          tp_atr_multiplier: '3.0',
        }),
      });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create bot');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleBot = async (bot: BotConfig) => {
    setError(null);
    try {
      const action = bot.status === 'RUNNING' ? 'stop' : 'start';
      await apiRequest(`/api/v1/bots/${bot.id}/${action}`, { method: 'POST' });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update bot status');
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        {error && (
          <div className="flex items-center gap-2 p-3 text-xs bg-[#EA3943]/10 border border-[#EA3943]/40 text-[#EA3943] rounded">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleCreate} className="terminal-card rounded p-5 space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[#8B92A0]">
            Deploy Futures Bot (Whitelisted Pairs Only)
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">API Key</label>
              <select
                required
                value={apiKeyId}
                onChange={(e) => setApiKeyId(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-[#0A0B0D] border border-[#22262E] rounded text-white"
              >
                {keys.length === 0 ? (
                  <option value="">Connect an API Key first</option>
                ) : (
                  keys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label} ({k.environment})
                    </option>
                  ))
                )}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">Pair</label>
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value as BotConfig['symbol'])}
                className="w-full px-3 py-2 text-xs font-mono bg-[#0A0B0D] border border-[#22262E] rounded text-white"
              >
                <option value="BTCUSDT">BTCUSDT</option>
                <option value="ETHUSDT">ETHUSDT</option>
                <option value="XAUUSDT">XAUUSDT (Gold Perpetual)</option>
                <option value="PAXGUSDT">PAXGUSDT (Gold Testnet Fallback)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">Strategy</label>
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as BotConfig['strategy'])}
                className="w-full px-3 py-2 text-xs font-mono bg-[#0A0B0D] border border-[#22262E] rounded text-white"
              >
                <option value="TREND_EMA_RSI_ATR">Trend_EMA_RSI_ATR</option>
                <option value="GRID_FUTURES_NEUTRAL">Grid_Futures_Neutral</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">Margin Mode</label>
              <select
                value={marginType}
                onChange={(e) => setMarginType(e.target.value as 'ISOLATED' | 'CROSSED')}
                className="w-full px-3 py-2 text-xs font-mono bg-[#0A0B0D] border border-[#22262E] rounded text-white"
              >
                <option value="ISOLATED">ISOLATED (Default Safe)</option>
                <option value="CROSSED">CROSSED</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">Leverage (1x - 20x max)</label>
              <input
                type="number"
                min={1}
                max={20}
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs num-tabular bg-[#0A0B0D] border border-[#22262E] rounded text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">Order Margin (USDT)</label>
              <input
                type="number"
                min={5}
                step="0.01"
                value={orderMargin}
                onChange={(e) => setOrderMargin(e.target.value)}
                className="w-full px-3 py-2 text-xs num-tabular bg-[#0A0B0D] border border-[#22262E] rounded text-white"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={submitting || keys.length === 0}
            className="px-4 py-2 text-xs font-semibold bg-[#16C784] text-[#0A0B0D] rounded hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Creating...' : 'Create Bot Config'}
          </button>
        </form>

        <div className="terminal-card rounded overflow-hidden">
          <div className="px-4 py-3 border-b border-[#22262E] text-xs font-semibold uppercase tracking-wider text-[#8B92A0]">
            Configured Bots
          </div>
          {loading ? (
            <div className="p-6 text-xs text-[#8B92A0]">Loading bots...</div>
          ) : bots.length === 0 ? (
            <div className="p-6 text-xs text-[#8B92A0]">No bot configurations created yet.</div>
          ) : (
            <div className="divide-y divide-[#22262E]">
              {bots.map((bot) => (
                <div
                  key={bot.id}
                  className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono font-semibold text-white">
                        {bot.symbol}
                      </span>
                      <span className="text-xs font-mono text-[#8B92A0]">{bot.strategy}</span>
                      <span
                        className={`text-[11px] font-mono px-1.5 py-0.5 border ${
                          bot.status === 'RUNNING'
                            ? 'border-[#16C784]/50 text-[#16C784]'
                            : bot.status === 'STOP_NEW_ENTRIES'
                            ? 'border-[#D4AF37]/50 text-[#D4AF37]'
                            : 'border-[#22262E] text-[#8B92A0]'
                        }`}
                      >
                        {bot.status}
                      </span>
                    </div>
                    <div className="text-xs num-tabular text-[#8B92A0]">
                      {bot.margin_type} · {bot.leverage}x · Margin ${bot.order_margin_usdt} · SL{' '}
                      {bot.sl_atr_multiplier}x ATR / TP {bot.tp_atr_multiplier}x ATR
                    </div>
                    {bot.last_error && (
                      <div className="text-xs text-[#EA3943]">{bot.last_error}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleBot(bot)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded ${
                      bot.status === 'RUNNING'
                        ? 'bg-[#EA3943]/15 text-[#EA3943] border border-[#EA3943]/40'
                        : 'bg-[#16C784] text-[#0A0B0D]'
                    }`}
                  >
                    {bot.status === 'RUNNING' ? (
                      <>
                        <Square className="w-3 h-3" /> Stop
                      </>
                    ) : (
                      <>
                        <Play className="w-3 h-3" /> Start
                      </>
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
};
