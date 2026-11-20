import React, { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Layout } from '../components/Layout';
import { apiRequest, type CreditTxItem } from '../lib/api';

interface VietQrOrder {
  order: { order_code: string };
  account_no: string;
  account_name: string;
  amount_vnd: string;
  qr_url: string;
}

export const WalletPage: React.FC = () => {
  const [txs, setTxs] = useState<CreditTxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [amountUsd, setAmountUsd] = useState('20');
  const [qrOrder, setQrOrder] = useState<VietQrOrder | null>(null);
  const [cryptoCode, setCryptoCode] = useState<string | null>(null);

  const loadTxs = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<CreditTxItem[]>('/api/v1/wallet/transactions');
      setTxs(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load wallet ledger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTxs();
  }, []);

  const createVietQr = async () => {
    setError(null);
    setCryptoCode(null);
    try {
      const res = await apiRequest<VietQrOrder>('/api/v1/wallet/deposits/vietqr', {
        method: 'POST',
        body: JSON.stringify({ credit_usd_amount: amountUsd }),
      });
      setQrOrder(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create VietQR order');
    }
  };

  const createCrypto = async () => {
    setError(null);
    setQrOrder(null);
    try {
      const res = await apiRequest<{ order_code: string }>('/api/v1/wallet/deposits/crypto', {
        method: 'POST',
        body: JSON.stringify({ credit_usd_amount: amountUsd }),
      });
      setCryptoCode(res.order_code);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create USDT BEP20 order');
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

        <div className="terminal-card rounded p-5 space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[#8B92A0]">
            Top Up Credit Balance (VietQR VND / USDT BEP20)
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">Amount (USD Credit)</label>
              <input
                type="number"
                min={5}
                value={amountUsd}
                onChange={(e) => setAmountUsd(e.target.value)}
                className="w-40 px-3 py-2 text-xs num-tabular bg-[#0A0B0D] border border-[#22262E] rounded text-white"
              />
            </div>
            <button
              type="button"
              onClick={createVietQr}
              className="px-4 py-2 text-xs font-semibold bg-[#D4AF37] text-[#0A0B0D] rounded"
            >
              Generate VietQR (SePay)
            </button>
            <button
              type="button"
              onClick={createCrypto}
              className="px-4 py-2 text-xs font-semibold border border-[#22262E] bg-[#0A0B0D] text-white rounded hover:border-[#8B92A0]"
            >
              Deposit USDT BEP20
            </button>
          </div>

          {qrOrder && (
            <div className="p-4 bg-[#0A0B0D] border border-[#22262E] rounded flex flex-col sm:flex-row gap-4 items-center">
              <img src={qrOrder.qr_url} alt="VietQR" className="w-40 h-40 bg-white p-1 rounded" />
              <div className="text-xs space-y-1.5">
                <div className="text-[#8B92A0]">
                  Transfer Code:{' '}
                  <span className="font-mono text-[#D4AF37] font-semibold">
                    {qrOrder.order.order_code}
                  </span>
                </div>
                <div className="text-[#8B92A0]">
                  Amount:{' '}
                  <span className="num-tabular text-white">
                    {Number(qrOrder.amount_vnd).toLocaleString('vi-VN')} VND
                  </span>
                </div>
                <div className="text-[#8B92A0]">
                  Account: <span className="font-mono text-white">{qrOrder.account_no}</span> (
                  {qrOrder.account_name})
                </div>
              </div>
            </div>
          )}

          {cryptoCode && (
            <div className="p-3 bg-[#0A0B0D] border border-[#22262E] rounded text-xs text-[#8B92A0]">
              USDT BEP20 Order Created:{' '}
              <span className="font-mono text-[#16C784]">{cryptoCode}</span> — awaiting NOWPayments
              IPN confirmation.
            </div>
          )}
        </div>

        <div className="terminal-card rounded overflow-hidden">
          <div className="px-4 py-3 border-b border-[#22262E] text-xs font-semibold uppercase tracking-wider text-[#8B92A0]">
            Credit & 20% High-Water Mark Audit Ledger
          </div>
          {loading ? (
            <div className="p-6 text-xs text-[#8B92A0]">Loading transactions...</div>
          ) : txs.length === 0 ? (
            <div className="p-6 text-xs text-[#8B92A0]">No credit transactions found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="border-b border-[#22262E] text-[#8B92A0] bg-[#0A0B0D]">
                  <tr>
                    <th className="px-4 py-2.5">Date</th>
                    <th className="px-4 py-2.5">Type</th>
                    <th className="px-4 py-2.5 text-right">Amount</th>
                    <th className="px-4 py-2.5 text-right">Balance After</th>
                    <th className="px-4 py-2.5 text-right">HWM Transition</th>
                    <th className="px-4 py-2.5">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#22262E]">
                  {txs.map((tx) => {
                    const amt = Number(tx.amount);
                    return (
                      <tr key={tx.id} className="hover:bg-[#1A1D24]">
                        <td className="px-4 py-2.5 num-tabular text-[#8B92A0]">
                          {new Date(tx.created_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-white">{tx.tx_type}</td>
                        <td className={`px-4 py-2.5 text-right num-tabular ${amt >= 0 ? 'text-[#16C784]' : 'text-[#EA3943]'}`}>
                          {amt >= 0 ? '+' : ''}${amt.toFixed(4)}
                        </td>
                        <td className="px-4 py-2.5 text-right num-tabular">
                          ${Number(tx.balance_after).toFixed(4)}
                        </td>
                        <td className="px-4 py-2.5 text-right num-tabular text-[#D4AF37]">
                          {tx.hwm_before && tx.hwm_after ? `$${tx.hwm_before} -> $${tx.hwm_after}` : '--'}
                        </td>
                        <td className="px-4 py-2.5 text-[#8B92A0]">{tx.note ?? '--'}</td>
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
