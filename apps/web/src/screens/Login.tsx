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
  const [forgot, setForgot] = useState(false);

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
        <div className="login-brand">
          <img src="/icon-192.png" alt="" className="login-logo" />
          <h1 className="login-title">Nexora POS</h1>
          <p className="muted login-sub">Ingresa tus datos para acceder al sistema</p>
        </div>
        {recovery && <p className="muted" data-testid="recovery-note">Si tenés cambios pendientes, ingresá con el mismo comercio para recuperarlos. No se borraron datos locales.</p>}
        <label htmlFor="identifier">Usuario o correo electrónico</label>
        <input
          id="identifier"
          data-testid="login-identifier"
          type="text"
          placeholder="usuario@nexora.com"
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
        <div className="login-forgot-row">
          <button
            type="button"
            className="login-forgot"
            data-testid="login-forgot"
            aria-expanded={forgot}
            onClick={() => setForgot((open) => !open)}
          >
            ¿Olvidaste tu contraseña?
          </button>
        </div>
        {forgot && (
          <p className="login-forgot-note" data-testid="login-forgot-note" role="status">
            Pídele a tu administrador que te la restablezca.
          </p>
        )}
        {error && (
          <p className="error" data-testid="login-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          data-testid="login-submit"
          className="btn primary login-submit"
          disabled={busy}
        >
          {busy ? "Ingresando…" : "Iniciar sesión"}
        </button>
      </form>
      <p className="login-footer">NEXORA POS © 2026</p>
    </div>
  );
}
