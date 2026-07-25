import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";

export function LoginPage() {
  const { login, loggingIn, error } = useAuth();
  const [password, setPassword] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    try {
      await login(password);
    } catch {
      // error surfaced via context
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>AY Trading Server</h1>
        <p className="subtitle">Enter the site password to continue.</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
        />
        {error && <p className="error-text">{error}</p>}
        <button type="submit" disabled={loggingIn || !password}>
          {loggingIn ? "Signing in…" : "Enter"}
        </button>
      </form>
    </div>
  );
}
