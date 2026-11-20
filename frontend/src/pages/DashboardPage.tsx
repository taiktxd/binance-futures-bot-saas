import React, { useEffect, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Layout } from '../components/Layout';
import { MarketPulse3D } from '../components/MarketPulse3D';
import { useMarketStream } from '../hooks/useMarketStream';
import { apiRequest, type PositionItem } from '../lib/api';

interface DashboardSummary {
  credit_balance: string;
  cumulative_net_pnl: string;
  high_water_mark: string;
  active_bots_count: number;
  open_positions: PositionItem[];
  active_gold_symbol: string;
  ws_feed_connected: boolean;
}

export const DashboardPage: React.FC = () => {
  const { ticks, connected } = useMarketStream();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<DashboardSummary>('/api/v1/dashboard/summary');
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSummary();
  }, []);

  const credit = Number(summary?.credit_balance ?? 0);
  const pnl = Number(summary?.cumulative_net_pnl ?? 0);
  const hwm = Number(summary?.high_water_mark ?? 0);

  return (
    <Layout>
      <div className="space-y-6">
        <MarketPulse3D
          ticks={ticks}
          goldSymbol={summary?.active_gold_symbol ?? 'XAUUSDT'}
          connected={connected || Boolean(summary?.ws_feed_connected)}
        />

        {error && (
          <div className="flex items-center justify-between p-3 text-xs bg-[#EA3943]/10 border border-[#EA3943]/40 text-[#EA3943] rounded">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={loadSummary}
              className="inline-flex items-center gap-1 underline"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="terminal-card rounded p-4">
            <div className="text-xs text-[#8B92A0]">Credit Balance</div>
            <div className={`mt-1 text-2xl font-semibold num-tabular ${credit <= 0 ? 'text-[#EA3943]' : 'text-white'}`}>
              {loading ? '...' : `$${credit.toFixed(2)}`}
            </div>
          </div>
          <div className="terminal-card rounded p-4">
            <div className="text-xs text-[#8B92A0]">Cumulative Net PnL</div>
            <div className={`mt-1 text-2xl font-semibold num-tabular ${pnl >= 0 ? 'text-[#16C784]' : 'text-[#EA3943]'}`}>
              {loading ? '...' : `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`}
            </div>
          </div>
          <div className="terminal-card rounded p-4">
            <div className="text-xs text-[#8B92A0]">High-Water Mark (HWM)</div>
            <div className="mt-1 text-2xl font-semibold num-tabular text-[#D4AF37]">
              {loading ? '...' : `$${hwm.toFixed(2)}`}
            </div>
          </div>
          <div className="terminal-card rounded p-4">
            <div className="text-xs text-[#8B92A0]">Active Bots</div>
            <div className="mt-1 text-2xl font-semibold num-tabular text-white">
              {loading ? '...' : summary?.active_bots_count ?? 0}
            </div>
          </div>
        </div>

        <div className="terminal-card rounded overflow-hidden">
          <div className="px-4 py-3 border-b border-[#22262E] flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#8B92A0]">
              Open Futures Positions
            </h2>
            <span className="text-xs num-tabular text-[#8B92A0]">
              {summary?.open_positions.length ?? 0} OPEN
            </span>
          </div>

          {loading ? (
            <div className="p-6 text-xs text-[#8B92A0]">Loading positions...</div>
          ) : !summary || summary.open_positions.length === 0 ? (
            <div className="p-6 text-xs text-[#8B92A0]">
              No open Futures positions. Configure an API Key and start a bot to begin execution.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="border-b border-[#22262E] text-[#8B92A0] bg-[#0A0B0D]">
                  <tr>
                    <th className="px-4 py-2.5">Symbol</th>
                    <th className="px-4 py-2.5">Side</th>
                    <th className="px-4 py-2.5">Margin / Lev</th>
                    <th className="px-4 py-2.5 text-right">Entry</th>
                    <th className="px-4 py-2.5 text-right">Qty</th>
                    <th className="px-4 py-2.5 text-right">SL / TP</th>
                    <th className="px-4 py-2.5 text-right">Unrealized PnL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#22262E]">
                  {summary.open_positions.map((pos) => {
                    const upnl = Number(pos.unrealized_pnl);
                    return (
                      <tr key={pos.id} className="hover:bg-[#1A1D24]">
                        <td className="px-4 py-2.5 font-mono font-medium text-white">{pos.symbol}</td>
                        <td className={`px-4 py-2.5 font-mono ${pos.side === 'LONG' ? 'text-[#16C784]' : 'text-[#EA3943]'}`}>
                          {pos.side}
                        </td>
                        <td className="px-4 py-2.5 num-tabular text-[#8B92A0]">
                          {pos.margin_type} {pos.leverage}x
                        </td>
                        <td className="px-4 py-2.5 text-right num-tabular">{pos.entry_price}</td>
                        <td className="px-4 py-2.5 text-right num-tabular">{pos.quantity}</td>
                        <td className="px-4 py-2.5 text-right num-tabular text-[#8B92A0]">
                          {pos.stop_loss_price} / {pos.take_profit_price}
                        </td>
                        <td className={`px-4 py-2.5 text-right num-tabular ${upnl >= 0 ? 'text-[#16C784]' : 'text-[#EA3943]'}`}>
                          {upnl >= 0 ? '+' : ''}${upnl.toFixed(2)}
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
