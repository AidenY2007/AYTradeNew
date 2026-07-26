import { NavLink, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { LoginPage } from "./auth/LoginPage";
import { OverviewPage } from "./pages/Overview";
import { TradeLogPage } from "./pages/TradeLog";
import { MissedEntriesPage } from "./pages/MissedEntries";
import { AnalysisPage } from "./pages/Analysis";
import { SettingsPage } from "./pages/Settings";

function AppShell() {
  const { logout } = useAuth();
  const nav = [
    { to: "/", label: "Overview", end: true },
    { to: "/analysis", label: "Analysis" },
    { to: "/trades", label: "Trade Log" },
    { to: "/missed", label: "Missed Entries" },
    { to: "/settings", label: "Settings" },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>AY Trading Server</h1>
        <nav>
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button className="logout" onClick={() => logout()}>
          Sign out
        </button>
      </aside>
      <div className="main">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/trades" element={<TradeLogPage />} />
          <Route path="/missed" element={<MissedEntriesPage />} />
          <Route path="/analysis" element={<AnalysisPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </div>
  );
}

function Gate() {
  const { ready, signedIn } = useAuth();
  if (!ready) return null;
  return signedIn ? <AppShell /> : <LoginPage />;
}

function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

export default App;
