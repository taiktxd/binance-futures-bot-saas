import React from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Lock, Shield, TrendingUp } from 'lucide-react';
import { Landing3DScene } from '../components/Landing3DScene';

export const LandingPage: React.FC = () => {
  return (
    <div className="min-h-screen bg-[#0A0B0D] text-[#E6E8EC]">
      <header className="h-14 border-b border-[#22262E] bg-[#121418] px-6 flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold text-sm tracking-tight">
          <Activity className="w-4 h-4 text-[#D4AF37]" />
          <span>QUANTCORE FUTURES</span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/login"
            className="px-3 py-1.5 text-xs font-medium text-[#8B92A0] hover:text-white"
          >
            Login
          </Link>
          <Link
            to="/register"
            className="px-3.5 py-1.5 text-xs font-semibold bg-[#D4AF37] text-[#0A0B0D] rounded hover:bg-[#c5a030]"
          >
            Start with $5.00 Credit
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12 space-y-12">
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
          <div className="lg:col-span-6 space-y-5">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 border border-[#22262E] bg-[#121418] text-xs font-mono text-[#D4AF37]">
              BINANCE USD-M FUTURES | BTC · ETH · XAU
            </div>
            <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-white leading-tight">
              Automated Futures Execution. Zero Monthly Fee. 20% High-Water Mark Only.
            </h1>
            <p className="text-sm text-[#8B92A0] leading-relaxed">
              Connect your Binance USD-M Futures API Key with withdrawal disabled and static IP
              whitelist. Built on a Rust event-driven execution engine with mandatory ISOLATED
              margin, Stop Loss, and Take Profit on every position.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Link
                to="/register"
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold bg-[#16C784] text-[#0A0B0D] rounded hover:opacity-90"
              >
                Create Account (+$5.00 Bonus Credit)
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
              <Link
                to="/dashboard"
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium border border-[#22262E] bg-[#121418] text-white rounded hover:border-[#8B92A0]"
              >
                Open Terminal
              </Link>
            </div>
          </div>

          <div className="lg:col-span-6">
            <Landing3DScene />
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="terminal-card rounded p-5 space-y-2">
            <TrendingUp className="w-4 h-4 text-[#16C784]" />
            <h2 className="text-sm font-semibold text-white">High-Water Mark 20% Billing</h2>
            <p className="text-xs text-[#8B92A0] leading-relaxed">
              Fees apply strictly to net realized profits above your historical HWM peak. Drawdown
              recovery periods incur $0.00 fee.
            </p>
          </div>
          <div className="terminal-card rounded p-5 space-y-2">
            <Lock className="w-4 h-4 text-[#D4AF37]" />
            <h2 className="text-sm font-semibold text-white">Non-Custodial AES-256-GCM</h2>
            <p className="text-xs text-[#8B92A0] leading-relaxed">
              Funds stay on your Binance account. API keys with withdrawal enabled are rejected on
              submission, and secrets are encrypted per-row with unique 96-bit nonces.
            </p>
          </div>
          <div className="terminal-card rounded p-5 space-y-2">
            <Shield className="w-4 h-4 text-[#3B82F6]" />
            <h2 className="text-sm font-semibold text-white">Zero Force-Close Guarantee</h2>
            <p className="text-xs text-[#8B92A0] leading-relaxed">
              If Credit reaches $0.00, bots switch to STOP_NEW_ENTRIES only. Open positions keep
              their TP/SL protection intact until closed naturally.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
};
