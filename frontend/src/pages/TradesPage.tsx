import React, { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Layout } from '../components/Layout';
import { apiRequest, type TradeItem } from '../lib/api';

export const TradesPage: React.FC = () => {
  const [trades, setTrades] = useState<TradeItem[]>([]);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchTrades = async () => {
      setLoading(true);
      setError(null);
      try {
        const qs = symbolFilter ? `?symbol=${symbolFilter}` : '';
        const res = await apiRequest<TradeItem[]>(`/api/v1/trades${qs}`);
        setTrades(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load trade history');
      } finally {
        setLoading(false);
      }
    };
    void fetchTrades();
  }, [symbolFilter]);

  return (
    <Layout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-semibold text-white">Executed Futures Trades</h1>
          <select
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value)}
            className="px-3 py-1.5 text-xs font-mono bg-[#121418] border border-[#22262E] rounded text-white"
          >
            <option value="">All Symbols</option>
            <option value="BTCUSDT">BTCUSDT</option>
            <option value="ETHUSDT">ETHUSDT</option>
            <option value="XAUUSDT">XAUUSDT</option>
            <option value="PAXGUSDT">PAXGUSDT</option>
          </select>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 text-xs bg-[#EA3943]/10 border border-[#EA3943]/40 text-[#EA3943] rounded">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="terminal-card rounded overflow-hidden">
          {loading ? (
            <div className="p-6 text-xs text-[#8B92A0]">Loading trade history...</div>
          ) : trades.length === 0 ? (
            <div className="p-6 text-xs text-[#8B92A0]">No closed trades recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="border-b border-[#22262E] text-[#8B92A0] bg-[#0A0B0D]">
                  <tr>
                    <th className="px-4 py-2.5">Time</th>
                    <th className="px-4 py-2.5">Symbol</th>
                    <th className="px-4 py-2.5">Side</th>
                    <th className="px-4 py-2.5 text-right">Entry / Exit</th>
                    <th className="px-4 py-2.5 text-right">Qty</th>
                    <th className="px-4 py-2.5 text-right">Realized PnL</th>
                    <th className="px-4 py-2.5 text-right">HWM Fee (20%)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#22262E]">
                  {trades.map((t) => {
                    const pnl = Number(t.realized_pnl);
                    return (
                      <tr key={t.id} className="hover:bg-[#1A1D24]">
                        <td className="px-4 py-2.5 num-tabular text-[#8B92A0]">
                          {new Date(t.executed_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-white">{t.symbol}</td>
                        <td className={`px-4 py-2.5 font-mono ${t.side === 'LONG' ? 'text-[#16C784]' : 'text-[#EA3943]'}`}>
                          {t.side}
                        </td>
                        <td className="px-4 py-2.5 text-right num-tabular">
                          {t.entry_price} / {t.exit_price}
                        </td>
                        <td className="px-4 py-2.5 text-right num-tabular">{t.quantity}</td>
                        <td className={`px-4 py-2.5 text-right num-tabular ${pnl >= 0 ? 'text-[#16C784]' : 'text-[#EA3943]'}`}>
                          {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                        </td>
                        <td className="px-4 py-2.5 text-right num-tabular text-[#D4AF37]">
                          ${Number(t.hwm_fee_charged).toFixed(4)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
};
