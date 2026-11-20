import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Copy, Trash2 } from 'lucide-react';
import { Layout } from '../components/Layout';
import { apiRequest, type MaskedApiKey } from '../lib/api';

interface ApiKeysPayload {
  server_static_ip: string;
  items: MaskedApiKey[];
}

export const ApiKeysPage: React.FC = () => {
  const [data, setData] = useState<ApiKeysPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [label, setLabel] = useState('Binance Futures Testnet');
  const [environment, setEnvironment] = useState<'TESTNET' | 'LIVE'>('TESTNET');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadKeys = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<ApiKeysPayload>('/api/v1/api-keys');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch API keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadKeys();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setStatusMsg(null);
    try {
      await apiRequest('/api/v1/api-keys', {
        method: 'POST',
        body: JSON.stringify({
          label,
          environment,
          api_key: apiKey,
          api_secret: apiSecret,
        }),
      });
      setApiKey('');
      setApiSecret('');
      setStatusMsg('API Key verified and encrypted with AES-256-GCM.');
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async (id: string) => {
    setError(null);
    setStatusMsg(null);
    try {
      const res = await apiRequest<{ available_usdt_balance: string; environment: string }>(
        `/api/v1/api-keys/${id}/test`,
        { method: 'POST' }
      );
      setStatusMsg(
        `Connection OK (${res.environment}) — Available Futures Balance: ${res.available_usdt_balance} USDT`
      );
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed');
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await apiRequest(`/api/v1/api-keys/${id}`, { method: 'DELETE' });
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="terminal-card rounded p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-white">VPS Static IP Whitelist</div>
            <div className="text-xs text-[#8B92A0] mt-0.5">
              Bind this IP in Binance API Management and keep Enable Withdrawals OFF.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <code className="px-3 py-1.5 bg-[#0A0B0D] border border-[#22262E] text-xs font-mono text-[#D4AF37] rounded">
              {data?.server_static_ip ?? 'Loading...'}
            </code>
            <button
              type="button"
              onClick={() => data && navigator.clipboard.writeText(data.server_static_ip)}
              className="p-2 border border-[#22262E] rounded hover:bg-[#1A1D24]"
              title="Copy IP"
            >
              <Copy className="w-3.5 h-3.5 text-[#8B92A0]" />
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 text-xs bg-[#EA3943]/10 border border-[#EA3943]/40 text-[#EA3943] rounded">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {statusMsg && (
          <div className="flex items-center gap-2 p-3 text-xs bg-[#16C784]/10 border border-[#16C784]/40 text-[#16C784] rounded">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{statusMsg}</span>
          </div>
        )}

        <form onSubmit={handleCreate} className="terminal-card rounded p-5 space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[#8B92A0]">
            Connect Binance USD-M Futures API Key
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">Label</label>
              <input
                type="text"
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-[#0A0B0D] border border-[#22262E] rounded text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">Environment</label>
              <select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as 'TESTNET' | 'LIVE')}
                className="w-full px-3 py-2 text-xs bg-[#0A0B0D] border border-[#22262E] rounded text-white"
              >
                <option value="TESTNET">TESTNET (Demo — Zero Cost)</option>
                <option value="LIVE">LIVE (Binance Futures Mainnet)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">API Key</label>
              <input
                type="text"
                required
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono bg-[#0A0B0D] border border-[#22262E] rounded text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">API Secret</label>
              <input
                type="password"
                required
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono bg-[#0A0B0D] border border-[#22262E] rounded text-white"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-xs font-semibold bg-[#D4AF37] text-[#0A0B0D] rounded hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Verifying with Binance...' : 'Verify & Save Key'}
          </button>
        </form>

        <div className="terminal-card rounded overflow-hidden">
          <div className="px-4 py-3 border-b border-[#22262E] text-xs font-semibold uppercase tracking-wider text-[#8B92A0]">
            Connected Keys
          </div>
          {loading ? (
            <div className="p-6 text-xs text-[#8B92A0]">Loading API keys...</div>
          ) : !data || data.items.length === 0 ? (
            <div className="p-6 text-xs text-[#8B92A0]">No API keys connected yet.</div>
          ) : (
            <div className="divide-y divide-[#22262E]">
              {data.items.map((item) => (
                <div
                  key={item.id}
                  className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">{item.label}</span>
                      <span className="text-[11px] font-mono px-1.5 py-0.5 border border-[#22262E] text-[#D4AF37]">
                        {item.environment}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-[#8B92A0]">{item.api_key_masked}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleTest(item.id)}
                      className="px-3 py-1.5 text-xs border border-[#22262E] rounded hover:bg-[#1A1D24]"
                    >
                      Test Connection
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(item.id)}
                      className="p-1.5 border border-[#22262E] rounded text-[#EA3943] hover:bg-[#EA3943]/10"
                      title="Delete Key"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
};
