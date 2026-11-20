import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { AppProvider } from './appState';
import IngestPage from './pages/IngestPage';
import CatalogPage from './pages/CatalogPage';
import RunsPage from './pages/RunsPage';
import DashboardPage from './pages/DashboardPage';
import ReviewPage from './pages/ReviewPage';
import RiskPage from './pages/RiskPage';

const NAV = [
  { to: '/ingest', label: '资料接入' },
  { to: '/catalog', label: '曲线与规则目录' },
  { to: '/runs', label: '平衡运行台' },
  { to: '/dashboard', label: '调度看板' },
  { to: '/risk', label: '断面风险' },
  { to: '/review', label: '复盘回查' },
];

export default function App() {
  return (
    <AppProvider>
      <div className="layout">
        <header className="topbar">
          <span className="brand">流域水库调度指标预计算与看板治理</span>
          <nav>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/ingest" element={<IngestPage />} />
            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/risk" element={<RiskPage />} />
            <Route path="/review" element={<ReviewPage />} />
          </Routes>
        </main>
      </div>
    </AppProvider>
  );
}
