import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { getAuthToken } from './lib/api';
import { LandingPage } from './pages/LandingPage';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { BotsPage } from './pages/BotsPage';
import { TradesPage } from './pages/TradesPage';
import { WalletPage } from './pages/WalletPage';
import { AdminPage } from './pages/AdminPage';

const RequireAuth: React.FC<{ children: React.ReactElement }> = ({ children }) => {
  return getAuthToken() ? children : <Navigate to="/login" replace />;
};

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route
          path="/dashboard"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/api-keys"
          element={
            <RequireAuth>
              <ApiKeysPage />
            </RequireAuth>
          }
        />
        <Route
          path="/bots"
          element={
            <RequireAuth>
              <BotsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/trades"
          element={
            <RequireAuth>
              <TradesPage />
            </RequireAuth>
          }
        />
        <Route
          path="/wallet"
          element={
            <RequireAuth>
              <WalletPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <AdminPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
};
