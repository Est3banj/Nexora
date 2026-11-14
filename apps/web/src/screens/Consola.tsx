import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Building2, Globe2, ShieldCheck } from "lucide-react";
import "./consola.css";

// Founder metadata only. No tenant-scoped fetch, local database or persistence.
type Tenant = {
  tenant_id: string; name: string; slug: string; users: number; pending: number;
  last_sync: string | null; errors: number; last_error: string | null;
};
type Status = "loading" | "ready" | "offline" | "forbidden" | "expired" | "error";
type View = "overview" | "tenants";
const views = [
  { id: "overview", label: "Resumen global", icon: Globe2 },
  { id: "tenants", label: "Tiendas / Tenants", icon: Building2 },
] as const;

export function Consola({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<View>("overview");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [status, setStatus] = useState<Status>("loading");
  const [rows, setRows] = useState<Tenant[]>([]);
  const [reload, setReload] = useState(0);
  const [created, setCreated] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const retry = () => { setRows([]); setStatus("loading"); setReload(n => n + 1); };

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const connected = () => setOnline(navigator.onLine);
    // Returning to the console always checks the current server flag again.
    const refresh = () => { if (document.visibilityState === "visible") setReload(n => n + 1); };
    window.addEventListener("online", connected);
    window.addEventListener("offline", connected);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("online", connected); window.removeEventListener("offline", connected);
      window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    if (!online) { setStatus("offline"); return; }
    setStatus("loading");
    void fetch("/api/founder/sync-status", {
      credentials: "same-origin", cache: "no-store", signal: controller.signal,
    }).then(async res => {
      if (controller.signal.aborted) return;
      if (!res.ok) { setStatus(res.status === 403 ? "forbidden" : res.status === 401 ? "expired" : "error"); return; }
      const body = await res.json() as { tenants: Tenant[] };
      if (controller.signal.aborted) return;
      if (!Array.isArray(body.tenants)) throw new Error("invalid_metadata");
      setRows(body.tenants); setStatus("ready");
    }).catch(() => { if (!controller.signal.aborted) setStatus("error"); });
    return () => controller.abort();
  }, [online, reload]);

  const protectedContent = online && status === "ready";
  return <div className="consola" data-testid="consola-screen">
    <aside className="consola-sidebar">
      <div className="consola-brand"><ShieldCheck aria-hidden="true" size={32} /><div><strong>NEXORA</strong><span>Consola de plataforma</span></div></div>
      <nav aria-label="Consola de plataforma" className="consola-nav">
        {views.map(({ id, label, icon: Icon }) => <button key={id} className="btn ghost" aria-current={view === id ? "page" : undefined}
          data-testid={`consola-nav-${id}`} onClick={() => { setView(id); setCreated(null); heading.current?.focus(); }}>
          <Icon size={20} aria-hidden="true" />{label}
        </button>)}
      </nav>
      <button className="btn ghost consola-back" data-testid="consola-back" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />Volver a la app</button>
    </aside>
    <div className="consola-workspace">
      <header className="consola-header"><h1 ref={heading} tabIndex={-1}>{views.find(v => v.id === view)!.label}</h1>
        <button className="btn ghost" data-testid="consola-refresh" disabled={!online || status === "loading"} onClick={retry}>Actualizar</button>
      </header>
      <main className="consola-main" aria-busy={online && status === "loading"}>
        <p className="muted">Administración del software · identidad, usuarios y estado de sincronización.</p>
        {!protectedContent && <section className="card consola-state" data-testid="consola-state">
          <p role={status === "loading" && online ? "status" : "alert"}>{!online ? "La consola requiere conexión" : {
            loading: "Consultando la plataforma…", ready: "", offline: "La consola requiere conexión",
            forbidden: "Tu acceso a la consola fue revocado. No tenés permiso de plataforma.",
            expired: "La sesión venció. Volvé a ingresar desde la app.", error: "No se pudo consultar la plataforma. Reintentá la consulta.",
          }[status]}</p>
          {online && status !== "loading" && <button className="btn primary" data-testid="consola-retry" onClick={retry}>Reintentar</button>}
        </section>}
        {protectedContent && <>
          {view === "overview" ? <section aria-label="Estado global" className="consola-stack">
            <div className="consola-metrics">
              {[
                ["Tiendas registradas", rows.length, "tenants"],
                ["Mutaciones pendientes", rows.reduce((n, r) => n + r.pending, 0), "pending"],
                ["Errores de sincronización", rows.reduce((n, r) => n + r.errors, 0), "errors"],
                ["Tiendas con errores", rows.filter(r => r.errors > 0).length, "affected"],
              ].map(([label, value, id]) => <article className="card consola-metric" key={id}><h2>{label}</h2><strong data-testid={`consola-${id}`}>{value}</strong></article>)}
            </div>
            <section className="card consola-state"><h2>Salud de sincronización</h2>
              <p>{!rows.length ? "Todavía no hay tiendas registradas." : rows.some(r => r.errors > 0) ? "Hay tiendas con errores de sincronización. Revisá el detalle en Tiendas / Tenants." : "Sin errores de sincronización registrados."}</p>
              <p className="muted">Los pendientes y errores reflejan el registro del servidor; no son una medición de dispositivos conectados.</p>
            </section>
          </section> : <section className="consola-stack" aria-label="Gestión de tiendas">
            <div className="card consola-state"><h2>Tiendas registradas</h2>
              {!rows.length ? <p data-testid="consola-empty">Todavía no hay tiendas registradas. Creá la primera tienda abajo.</p> : <div className="table-scroll" role="region" aria-label="Estado de las tiendas" tabIndex={0}>
                <table><caption>Identidad y sincronización por tienda</caption><thead><tr>{["Tienda / slug", "Usuarios", "Pendientes", "Última sync", "Errores", "Último error"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
                  <tbody>{rows.map(row => <tr key={row.tenant_id} data-testid="consola-tenant"><th scope="row"><strong>{row.name}</strong><code>{row.slug}</code></th><td>{row.users}</td><td>{row.pending}</td><td>{row.last_sync ? new Date(row.last_sync).toLocaleString("es-CO") : "Sin sincronizaciones"}</td><td>{row.errors}</td><td>{row.last_error ?? "Sin errores registrados"}</td></tr>)}</tbody>
                </table>
              </div>}
            </div>
            <CreateTenant onDenied={code => { setRows([]); setCreated(null); setStatus(code === 403 ? "forbidden" : "expired"); }}
              onCreated={name => { retry(); setCreated(name); }} />
          </section>}
          {created && <p role="status">Tienda creada: {created}.</p>}
        </>}
      </main>
    </div>
  </div>;
}

function CreateTenant({ onCreated, onDenied }: { onCreated: (name: string) => void; onDenied: (code: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = { name: String(data.get("name")).trim(), slug: String(data.get("slug")).trim() || undefined,
      email: String(data.get("email")).trim(), password: String(data.get("password")) };
    // Secret lives only in the outgoing request, never in URL/storage/logs.
    (form.elements.namedItem("password") as HTMLInputElement).value = "";
    setBusy(true); setError(null);
    controller.current = new AbortController();
    const signal = controller.current.signal;
    try {
      const res = await fetch("/api/founder/tenants", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal });
      if (signal.aborted) return;
      if (res.status === 401 || res.status === 403) { onDenied(res.status); return; }
      if (!res.ok) {
        setError(res.status === 409 ? "El correo o slug ya está en uso. Revisá los datos e ingresá la contraseña otra vez." : "No se pudo crear la tienda. Revisá la lista antes de reintentar e ingresá la contraseña otra vez.");
        return;
      }
      const body = await res.json() as { tenant: { name: string } };
      if (!signal.aborted) { form.reset(); onCreated(body.tenant.name); }
    } catch {
      if (!signal.aborted) setError("No se pudo confirmar la creación. Actualizá la lista antes de reintentar; la tienda podría haberse creado.");
    } finally { if (!signal.aborted) setBusy(false); }
  }
  return <section className="card consola-state"><h2>Crear tienda</h2>
    <p className="muted">Creá la organización y su primer usuario dueño. La tienda comienza con un catálogo vacío.</p>
    <form onSubmit={event => void submit(event)} autoComplete="off" aria-busy={busy}>
      <fieldset disabled={busy} className="consola-fields"><legend>Datos de la tienda y acceso inicial</legend>
        <label>Nombre de la tienda<input name="name" data-testid="consola-create-name" required minLength={2} maxLength={80} /></label>
        <label>Slug (opcional)<input name="slug" data-testid="consola-create-slug" minLength={2} maxLength={48} pattern="[a-z0-9-]+" autoCapitalize="none" spellCheck={false} /><small>Minúsculas, números y guiones. Si lo dejás vacío, se genera en el servidor.</small></label>
        <label>Correo del dueño<input name="email" type="email" data-testid="consola-create-email" autoCapitalize="none" required autoComplete="off" /></label>
        <label>Contraseña inicial<input name="password" type="password" data-testid="consola-create-password" required minLength={8} maxLength={100} autoComplete="new-password" /><small>Se borra del formulario al enviar o salir de esta vista.</small></label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <button className="btn primary" data-testid="consola-create-submit" disabled={busy}>{busy ? "Creando tienda…" : "Crear tienda"}</button>
    </form>
  </section>;
}
