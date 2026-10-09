import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Me } from "./api";
import { Loading, MeContext } from "./components/ui";
import { CoveragePage } from "./pages/Coverage";
import { ExplorerPage } from "./pages/Explorer";
import { InspectPage } from "./pages/Inspect";
import { PairPage } from "./pages/Pair";
import { RunSetupPage } from "./pages/RunSetup";
import { RunsPage } from "./pages/Runs";
import { RunMonitorPage } from "./pages/RunMonitor";
import { ResultsPage } from "./pages/Results";
import { ReviewPage } from "./pages/Review";
import { AdminPage } from "./pages/Admin";
import { LoginPage } from "./pages/Login";

const NAV: { to: string; label: string; perm?: string; section?: string }[] = [
  { to: "/", label: "Data coverage", section: "Data" },
  { to: "/explore", label: "Trajectories" },
  { to: "/runs/new", label: "Experiment setup", perm: "runs.write", section: "Experiments" },
  { to: "/runs", label: "Run monitor" },
  { to: "/results", label: "Results" },
  { to: "/review", label: "Human review", perm: "review.write", section: "Review" },
  { to: "/admin", label: "Operations", perm: "jobs.admin", section: "Admin" },
];

export function App() {
  const qc = useQueryClient();
  const loc = useLocation();
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  const me = useQuery<Me, ApiError>({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/auth/me"), retry: false });

  useEffect(() => setMenu(false), [loc.pathname]);

  // A one-time login link (`#login=<token>`) from `agenthorizon bootstrap`: exchange it for a session cookie and
  // remove the token from the address bar immediately.
  const [linkLogin, setLinkLogin] = useState<string | null>(() => {
    const m = window.location.hash.match(/login=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  });
  useEffect(() => {
    if (!linkLogin) return;
    history.replaceState(null, "", window.location.pathname + window.location.search);
    api.post("/api/auth/login", { token: linkLogin })
      .then(() => qc.invalidateQueries({ queryKey: ["me"] }))
      .finally(() => setLinkLogin(null));
  }, [linkLogin, qc]);

  if (me.isLoading || linkLogin) return <Loading label="Checking session" />;
  if (me.isError || !me.data) return <LoginPage onDone={() => qc.invalidateQueries({ queryKey: ["me"] })} />;
  const user = me.data;

  async function logout() {
    await api.post("/api/auth/logout").catch(() => undefined);
    qc.clear();
    nav("/");
    qc.invalidateQueries({ queryKey: ["me"] });
  }

  return (
    <MeContext.Provider value={user}>
      <div className="mobile-bar">
        <button className="ghost" aria-expanded={menu} aria-controls="sidebar" onClick={() => setMenu(!menu)}>☰ Menu</button>
        <strong>AgentHorizon Workbench</strong>
      </div>
      <div className="shell">
        <nav id="sidebar" className={`sidebar ${menu ? "open" : ""}`} aria-label="Main">
          <div className="brand">
            <img src="/favicon.svg" alt="" />
            <span>AgentHorizon<br /><span className="subtle">Research workbench</span></span>
          </div>
          <div className="nav">
            {NAV.filter((n) => !n.perm || user.permissions.includes(n.perm)).map((n) => (
              <div key={n.to}>
                {n.section ? <div className="nav-sep">{n.section}</div> : null}
                <NavLink to={n.to} end={n.to === "/" || n.to === "/runs"}>{n.label}</NavLink>
              </div>
            ))}
          </div>
          <div className="sidebar-foot">
            <div><strong>{user.user_id}</strong> · {user.role}</div>
            <div className="subtle">{user.mode === "local" ? "local single-user mode" : "hosted mode"}</div>
            <button className="ghost" style={{ paddingLeft: 0 }} onClick={logout}>Sign out</button>
          </div>
        </nav>
        <main className="main" id="content">
          <Routes>
            <Route path="/" element={<CoveragePage />} />
            <Route path="/explore" element={<ExplorerPage />} />
            <Route path="/explore/:dv" element={<ExplorerPage />} />
            <Route path="/explore/:dv/:eid" element={<InspectPage />} />
            <Route path="/explore/:dv/:eid/pair" element={<PairPage />} />
            <Route path="/runs/new" element={<RunSetupPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/runs/:runId" element={<RunMonitorPage />} />
            <Route path="/results" element={<ResultsPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/review/:dv/:eid" element={<ReviewPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<div className="empty"><h3>Page not found</h3></div>} />
          </Routes>
        </main>
      </div>
    </MeContext.Provider>
  );
}
