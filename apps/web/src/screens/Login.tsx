import { useState, type FormEvent } from "react";
import { authClient, loginErrorMessage } from "../auth";
import { PasswordInput } from "../components/PasswordInput";

/**
 * ONE identity field: "Usuario o correo".
 * Contains "@" → the email/owner path (/sign-in/email); anything else is a
 * member username (/sign-in/username). The user never has to pick an account
 * type — that branch is the only UX decision this screen makes.
 */
export function Login({ recovery = false, onAuthenticated }: { recovery?: boolean; onAuthenticated?: () => void } = {}) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = identifier.trim();
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = value.includes("@")
        ? await authClient.signIn.email({ email: value, password })
        : await authClient.signIn.username({ username: value, password });
      if (signInError) {
        setError(loginErrorMessage(signInError.code));
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
        <label htmlFor="identifier">Usuario o correo</label>
        <input
          id="identifier"
          data-testid="login-identifier"
          type="text"
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="username"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
        <PasswordInput
          id="password"
          label="Contraseña"
          data-testid="login-password"
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
