import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * P1-3 · last line of defence for the React tree.
 *
 * Mounted in main.tsx AROUND <App>, which is what makes it cover every
 * early-return branch inside App (secondTab / bootError / booting / no-tenant
 * / access-blocked / …) as well as any error thrown while rendering them.
 * The existing boot-failure path in App.tsx is an ordinary state
 * (`bootError` → notice-screen), NOT an exception — it never reaches this
 * boundary and keeps its own copy untouched.
 *
 * The fallback reuses the shared `notice-screen` composition so a crash looks
 * like the rest of the app's blocking states, not like a white page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // console.error, not a swallowed no-op: this is the only place the stack
    // + component tree of the crash is recorded.
    console.error("[nexora] unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="notice-screen" data-testid="error-boundary" role="alert">
          <h1>Algo salió mal</h1>
          <p className="muted">
            La pantalla encontró un error inesperado. Tus datos locales siguen guardados.
          </p>
          <button
            type="button"
            className="btn primary"
            data-testid="error-boundary-reload"
            onClick={() => window.location.reload()}
          >
            Recargar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
