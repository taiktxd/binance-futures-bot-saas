import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Bot,
  History,
  KeyRound,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { setAuthToken } from '../lib/api';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/api-keys', label: 'API Keys', icon: KeyRound },
  { to: '/bots', label: 'Bots', icon: Bot },
  { to: '/trades', label: 'Trades', icon: History },
  { to: '/wallet', label: 'Wallet & HWM', icon: Wallet },
  { to: '/admin', label: 'Admin', icon: ShieldCheck },
];

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogout = () => {
    setAuthToken(null);
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-[#0A0B0D] text-[#E6E8EC] flex flex-col">
      <header className="h-14 border-b border-[#22262E] bg-[#121418] px-4 lg:px-6 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight text-sm">
            <Activity className="w-4 h-4 text-[#D4AF37]" />
            <span>QUANTCORE FUTURES</span>
            <span className="text-[11px] px-1.5 py-0.5 border border-[#22262E] text-[#8B92A0] num-tabular">
              USD-M
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
              const active = location.pathname === to;
              return (
                <Link
                  key={to}
                  to={to}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                    active
                      ? 'bg-[#22262E] text-white'
                      : 'text-[#8B92A0] hover:text-white hover:bg-[#1A1D24]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </Link>
              );
            })}
          </nav>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center gap-1.5 text-xs text-[#8B92A0] hover:text-[#EA3943] transition-colors"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign Out
        </button>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-6 py-6">{children}</main>
    </div>
  );
};
