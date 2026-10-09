import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";

export function LoginPage({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/login", { token: token.trim() });
      setToken("");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login card">
      <h1>AgentHorizon Workbench</h1>
      <p className="muted">
        Sign in with an access token. In local mode, <code>agenthorizon bootstrap</code> prints an operator token and a one-time
        login link; operators can issue tokens for researchers, reviewers, and viewers.
      </p>
      <form onSubmit={submit} className="stack">
        <label className="field">
          Access token
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required autoFocus />
        </label>
        {error ? <div className="banner danger" role="alert">{error}</div> : null}
        <button className="primary" type="submit" disabled={busy || !token.trim()}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="subtle" style={{ marginTop: "1rem" }}>
        The session is an HttpOnly cookie; the token is never stored by this page.
      </p>
    </div>
  );
}
