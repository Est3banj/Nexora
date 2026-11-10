import { useState, type FormEvent } from "react";
import { authClient } from "../auth";

export function Login({ recovery = false, onAuthenticated }: { recovery?: boolean; onAuthenticated?: () => void } = {}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = await authClient.signIn.email({ email, password });
      if (signInError) {
        setError("No se pudo ingresar. Revisá el correo, la contraseña y la conexión.");
        return;
      }
      // Stale-active-org guard: ALWAYS set-active after sign-in.
      try {
        const orgs = await authClient.organization.list();
        const first = orgs.data?.[0];
        if (first) await authClient.organization.setActive({ organizationId: first.id });
      } catch {
        // Offline/no org: App keeps business data sealed until it can claim.
      }
      onAuthenticated?.();
    } catch {
      setError("No se pudo conectar. Tus datos locales siguen guardados; reintentá con conexión.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="card login-card" onSubmit={submit}>
        <h1><img src="/icon-192.png" alt="" className="login-logo" /> NEXORA</h1>
        <p className="muted">Ingresá para vender</p>
        {recovery && <p className="muted" data-testid="recovery-note">Si tenés cambios pendientes, ingresá con el mismo comercio para recuperarlos. No se borraron datos locales.</p>}
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
