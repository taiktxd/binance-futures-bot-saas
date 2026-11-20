import React, { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Layout } from '../components/Layout';
import { apiRequest, type UserProfile } from '../lib/api';

interface EngineStatus {
  ws_feed_connected: boolean;
  active_gold_symbol: string;
  total_users: number;
  running_bots: number;
  stop_new_entries_bots: number;
  open_positions: number;
}

export const AdminPage: React.FC = () => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adjustAmount, setAdjustAmount] = useState<Record<string, string>>({});

  const loadAdmin = async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, e] = await Promise.all([
        apiRequest<UserProfile[]>('/api/v1/admin/users'),
        apiRequest<EngineStatus>('/api/v1/admin/engine-status'),
      ]);
      setUsers(u);
      setEngine(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Admin access required');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAdmin();
  }, []);

  const handleAdjust = async (userId: string) => {
    const val = adjustAmount[userId];
    if (!val) return;
    setError(null);
    try {
      await apiRequest(`/api/v1/admin/users/${userId}/credit-adjust`, {
        method: 'POST',
        body: JSON.stringify({ amount: val, note: 'Manual admin credit adjustment' }),
      });
      setAdjustAmount((prev) => ({ ...prev, [userId]: '' }));
      await loadAdmin();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Adjustment failed');
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

        {engine && (
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="terminal-card rounded p-3">
              <div className="text-[11px] text-[#8B92A0]">Rust WS Feed</div>
              <div className={`mt-1 text-sm font-mono ${engine.ws_feed_connected ? 'text-[#16C784]' : 'text-[#EA3943]'}`}>
                {engine.ws_feed_connected ? 'CONNECTED' : 'DISCONNECTED'}
              </div>
            </div>
            <div className="terminal-card rounded p-3">
              <div className="text-[11px] text-[#8B92A0]">Gold Symbol</div>
              <div className="mt-1 text-sm font-mono text-[#D4AF37]">{engine.active_gold_symbol}</div>
            </div>
            <div className="terminal-card rounded p-3">
              <div className="text-[11px] text-[#8B92A0]">Users</div>
              <div className="mt-1 text-sm num-tabular text-white">{engine.total_users}</div>
            </div>
            <div className="terminal-card rounded p-3">
              <div className="text-[11px] text-[#8B92A0]">Running / Locked Bots</div>
              <div className="mt-1 text-sm num-tabular text-white">
                {engine.running_bots} / {engine.stop_new_entries_bots}
              </div>
            </div>
            <div className="terminal-card rounded p-3">
              <div className="text-[11px] text-[#8B92A0]">Open Positions</div>
              <div className="mt-1 text-sm num-tabular text-white">{engine.open_positions}</div>
            </div>
          </div>
        )}

        <div className="terminal-card rounded overflow-hidden">
          <div className="px-4 py-3 border-b border-[#22262E] text-xs font-semibold uppercase tracking-wider text-[#8B92A0]">
            Users & Manual Credit Adjustments
          </div>
          {loading ? (
            <div className="p-6 text-xs text-[#8B92A0]">Loading admin records...</div>
          ) : users.length === 0 ? (
            <div className="p-6 text-xs text-[#8B92A0]">No users found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="border-b border-[#22262E] text-[#8B92A0] bg-[#0A0B0D]">
                  <tr>
                    <th className="px-4 py-2.5">Email</th>
                    <th className="px-4 py-2.5 text-right">Credit</th>
                    <th className="px-4 py-2.5 text-right">Net PnL</th>
                    <th className="px-4 py-2.5 text-right">HWM</th>
                    <th className="px-4 py-2.5 text-right">Adjust (+/- USD)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#22262E]">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-[#1A1D24]">
                      <td className="px-4 py-2.5 text-white">{u.email}</td>
                      <td className="px-4 py-2.5 text-right num-tabular">
                        ${Number(u.credit_balance).toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5 text-right num-tabular">
                        ${Number(u.cumulative_net_pnl).toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5 text-right num-tabular text-[#D4AF37]">
                        ${Number(u.high_water_mark).toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <input
                            type="number"
                            step="0.01"
                            placeholder="+10"
                            value={adjustAmount[u.id] ?? ''}
                            onChange={(e) =>
                              setAdjustAmount((prev) => ({ ...prev, [u.id]: e.target.value }))
                            }
                            className="w-20 px-2 py-1 text-xs num-tabular bg-[#0A0B0D] border border-[#22262E] rounded text-white"
                          />
                          <button
                            type="button"
                            onClick={() => handleAdjust(u.id)}
                            className="px-2.5 py-1 text-xs bg-[#22262E] hover:bg-[#D4AF37] hover:text-[#0A0B0D] rounded"
                          >
                            Apply
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
};
