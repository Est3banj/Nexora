import { useState, type FormEvent } from "react";
import { authClient } from "../auth";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    });
    if (signInError) {
      setError("Correo o contraseña incorrectos");
      setBusy(false);
      return;
    }
    // Stale-active-org guard (design §4): ALWAYS set-active after sign-in.
    try {
      const orgs = await authClient.organization.list();
      const first = orgs.data?.[0];
      if (first) {
        await authClient.organization.setActive({ organizationId: first.id });
      }
    } catch {
      // offline or no org — the app shows the no-tenant state and retries
    }
    setBusy(false);
  }

  return (
    <div className="login-screen">
      <form className="card login-card" onSubmit={submit}>
        <h1><img src="/icon-192.png" alt="" className="login-logo" /> NEXORA</h1>
        <p className="muted">Ingresá para vender</p>
        <label htmlFor="email">Correo</label>
        <input
          id="email"
          data-testid="login-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          data-testid="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="error" data-testid="login-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          data-testid="login-submit"
          className="btn primary"
          disabled={busy}
        >
          {busy ? "Ingresando…" : "Ingresar"}
        </button>
      </form>
    </div>
  );
}
