import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, AlertCircle } from 'lucide-react';
import { apiRequest, setAuthToken } from '../lib/api';

interface AuthPageProps {
  mode: 'login' | 'register';
}

export const AuthPage: React.FC<AuthPageProps> = ({ mode }) => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const endpoint = mode === 'register' ? '/api/v1/auth/register' : '/api/v1/auth/login';
      const body =
        mode === 'register'
          ? { email, password, telegram_chat_id: telegramChatId || null }
          : { email, password };
      const resp = await apiRequest<{ token: string }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setAuthToken(resp.token);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0B0D] flex items-center justify-center px-4">
      <div className="w-full max-w-md terminal-card rounded p-6 space-y-5">
        <div className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-sm font-semibold text-white">
            <Activity className="w-4 h-4 text-[#D4AF37]" />
            QUANTCORE FUTURES
          </Link>
          <span className="text-xs font-mono text-[#8B92A0]">
            {mode === 'register' ? '+$5.00 BONUS' : 'TERMINAL AUTH'}
          </span>
        </div>

        <div>
          <h1 className="text-lg font-semibold text-white">
            {mode === 'register' ? 'Create Account' : 'Sign In'}
          </h1>
          <p className="text-xs text-[#8B92A0] mt-1">
            {mode === 'register'
              ? 'New accounts receive $5.00 non-withdrawable Bonus Credit for HWM fees.'
              : 'Authenticate to manage API keys, bots, and live Futures positions.'}
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 text-xs bg-[#EA3943]/10 border border-[#EA3943]/40 text-[#EA3943] rounded">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-[#8B92A0] mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-[#0A0B0D] border border-[#22262E] rounded text-white focus:outline-none focus:border-[#D4AF37]"
              placeholder="trader@domain.com"
            />
          </div>

          <div>
            <label className="block text-xs text-[#8B92A0] mb-1">Password (min 8 chars)</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-[#0A0B0D] border border-[#22262E] rounded text-white focus:outline-none focus:border-[#D4AF37]"
            />
          </div>

          {mode === 'register' && (
            <div>
              <label className="block text-xs text-[#8B92A0] mb-1">
                Telegram Chat ID (Optional — for Credit & Trade Alerts)
              </label>
              <input
                type="text"
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-[#0A0B0D] border border-[#22262E] rounded text-white focus:outline-none focus:border-[#D4AF37]"
                placeholder="123456789"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 text-xs font-semibold bg-[#16C784] text-[#0A0B0D] rounded hover:opacity-90 disabled:opacity-50"
          >
            {loading
              ? 'Processing...'
              : mode === 'register'
              ? 'Register & Claim $5.00 Credit'
              : 'Sign In'}
          </button>
        </form>

        <div className="text-xs text-[#8B92A0] text-center">
          {mode === 'register' ? (
            <>
              Already registered?{' '}
              <Link to="/login" className="text-[#D4AF37] hover:underline">
                Sign in
              </Link>
            </>
          ) : (
            <>
              No account yet?{' '}
              <Link to="/register" className="text-[#D4AF37] hover:underline">
                Register for $5.00 Bonus
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
