import { useEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";

export type ShellAlert = { id: string; label: string; action: () => void | Promise<unknown> };

export function NotificationPopover({ alerts, loading, error, onRetry }: {
  alerts: ShellAlert[]; loading: boolean; error: boolean; onRetry: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);
  useEffect(() => {
    const close = () => { dialog.current?.close(); };
    window.addEventListener("pos:close-popovers", close);
    return () => window.removeEventListener("pos:close-popovers", close);
  }, []);
  return <>
    <button className="icon-button notification-trigger" data-testid="notifications" ref={trigger}
      aria-label={`Alertas${alerts.length ? `: ${alerts.length}` : ""}`} aria-haspopup="dialog"
      onClick={() => { setActionError(false); dialog.current?.showModal(); }}>
      <Bell size={20} aria-hidden="true" />
      {alerts.length > 0 && <span className="notification-count" data-testid="notification-count">{alerts.length}</span>}
    </button>
    <dialog ref={dialog} className="notification-popover" aria-labelledby="notifications-title" data-testid="notification-panel"
      onClose={() => trigger.current?.focus()} onCancel={event => { if (busy) event.preventDefault(); }}>
      <div className="row space-between"><h2 id="notifications-title">Alertas</h2><button className="icon-button" aria-label="Cerrar alertas" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} aria-hidden="true" /></button></div>
      {loading && <p role="status">Consultando alertas…</p>}
      {error ? <p role="alert">No se pudieron consultar las alertas. <button className="btn small" onClick={onRetry}>Reintentar consulta</button></p> : !loading && alerts.length === 0 && <p className="muted">Sin alertas</p>}
      {actionError && <p role="alert">No se pudo completar la acción. Tus datos siguen guardados.</p>}
      <div className="notification-list" aria-busy={busy}>{alerts.map(alert => <button key={alert.id} className="notification-action" disabled={busy} onClick={() => {
        setBusy(true);
        void Promise.resolve().then(alert.action).then(() => dialog.current?.close()).catch(() => setActionError(true)).finally(() => setBusy(false));
      }}>{alert.label}</button>)}</div>
    </dialog>
  </>;
}
