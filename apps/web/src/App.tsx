import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "./components/AppShell";
import { Toast, type ToastKind, type ToastMessage } from "./components/Toast";
import type { AppTab } from "./components/navigation";
import { Credito } from "./screens/Credito";
import { activeOrgId, authClient } from "./auth";
import type { LocalHandle } from "./db/pglite";
import { claimLocal, sealLocal, unresolvedWork } from "./db/preservation";
import { safeTransition, type TransitionState } from "./sync/safe-transition";
import { getLocalDb, planBoot, switchToCurrentDatadir } from "./db/instance";
import {
  clearLocalBusinessData,
  isLocalCacheEmpty,
  type SaleItem,
} from "./db/local";
import { CommandPalette } from "./components/CommandPalette";
import {
  retryPoison,
  stopSync,
  initSync,
  pushNow,
  refreshSyncStatus,
  repushSynced,
} from "./sync/queue";
import { rehydrateFromServer } from "./sync/rehydrate";
import { useSync } from "./hooks/useSync";
import { Login } from "./screens/Login";
import { Sale } from "./screens/Sale";
import { Catalog } from "./screens/Catalog";
import { Tickets } from "./screens/Tickets";
import { Arqueo } from "./screens/Arqueo";
import { Reports } from "./screens/Reports";
import { Dashboard } from "./screens/Dashboard";

type Tab = AppTab;

export default function App() {
  const { data: session, isPending } = authClient.useSession();
  const [local, setLocal] = useState<LocalHandle | null>(null);
  const [secondTab, setSecondTab] = useState(false);
  const [bootError, setBootError] = useState(false);
  const [tab, setTab] = useState<Tab>("sale");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastId = useRef(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [tenantName, setTenantName] = useState<string>();
  const [transition, setTransition] = useState<TransitionState>({ phase: "idle" });
  const [intent, setIntent] = useState<"logout" | "upgrade">("logout");
  const [ready, setReady] = useState<string | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [recoveryNeeded, setRecoveryNeeded] = useState(false);
  const [reauth, setReauth] = useState(() => localStorage.getItem("pos:reauth") === "1");
  const upgradeRef = useRef<"idle" | "running" | "done">("idle");
  const sync = useSync();

  // Single-tab guard + schema bootstrap (task D1-6). getLocalDb is a
  // page-lifetime singleton; the lock releases on pagehide.
  useEffect(() => {
    let alive = true;
    void getLocalDb({
      onSecondTab: () => setSecondTab(true),
    })
      .then((handle) => {
        if (alive && handle) setLocal(handle);
      })
      .catch(() => {
        if (alive) setBootError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const tenantId = activeOrgId(session);
  const sessionKey = session && tenantId ? `${session.session.id}:${tenantId}` : null;

  /* ── Command palette (Batch C) — Ctrl/Cmd+K or "/" ───────────────── */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingProduct, setPendingProduct] = useState<SaleItem | null>(null);
  const [pendingTicketId, setPendingTicketId] = useState<string | null>(null);
  const [pendingVariantId, setPendingVariantId] = useState<string | null>(null);
  const consumeVariant = useCallback(() => setPendingVariantId(null), []);
  const consumeProduct = useCallback(() => setPendingProduct(null), []);
  const consumeTicket = useCallback(() => setPendingTicketId(null), []);
  const paletteReady = Boolean(
    local && tenantId && ready === sessionKey && transition.phase === "idle",
  );

  useEffect(() => {
    if (!paletteReady) {
      setPaletteOpen(false);
      return;
    }
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        if (document.querySelector("dialog[open]")) return;
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.key === "/" && !e.shiftKey) {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          t?.isContentEditable
        )
          return;
        if (t?.closest("dialog") || document.querySelector("dialog[open]"))
          return;
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteReady]);

  // Sync engine: crash recovery (in_flight→pending), live status, and the
  // boot/reconnect auto-push. Re-runs after a datadir switch too (D2-5).
  useEffect(() => {
    if (!local) return;
    let alive = true;
    setReady(null);
    setTenantName(undefined);
    setToast(null);
    setTab("sale");
    setPendingProduct(null);
    setPendingTicketId(null);
    setPendingVariantId(null);
    void (async () => {
      try {
        await stopSync();
        await sealLocal(local.db);
        const pending = await unresolvedWork(local.db);
        if (alive) setRecoveryNeeded(pending > 0);
        if (!tenantId || !sessionKey || reauth || !alive) return;
        await claimLocal(local.db, tenantId);
        if (!alive) { await sealLocal(local.db); return; }
        setAccessError(null);
        setReady(sessionKey);
        await initSync(local.db, tenantId);
      } catch (error) {
        if (alive) setAccessError(error instanceof Error ? error.message : "No se pudo recuperar la base protegida");
      }
    })();
    // A completed datadir switch has already closed the previous handle.
    return () => { alive = false; void stopSync(); void sealLocal(local.db).catch(() => {}); };
  }, [local, tenantId, sessionKey, reauth]);

  // D4-4 first-boot / post-wipe rehydrate: empty local cache against a
  // populated server must pull truth BEFORE the first sale (ticket_no
  // sequence + catalog). No-op for a brand-new empty tenant.
  // Bumps refreshToken so Sale/Catalog/Tickets re-query after the pull —
  // otherwise a fresh device stays on the empty state forever.
  useEffect(() => {
    if (!local || !tenantId || ready !== sessionKey || transition.phase !== "idle") return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let alive = true;
    void (async () => {
      try {
        if (!(await isLocalCacheEmpty(local.db, tenantId))) return;
        if (!alive) return;
        const result = await rehydrateFromServer(local.db, tenantId);
        if (alive && result.inserted > 0) setRefreshToken((n) => n + 1);
      } catch {
        /* offline/race — next reconnect path retries via upgrade/rehydrate */
      }
    })();
    return () => {
      alive = false;
    };
  }, [local, tenantId, ready, sessionKey, transition.phase]);

  // Self-heal: session without active org (fresh sign-in / cache) → set-active.
  useEffect(() => {
    if (!session || tenantId || typeof navigator === "undefined") return;
    if (!navigator.onLine) return;
    void (async () => {
      const orgs = await authClient.organization.list();
      const first = orgs.data?.[0];
      if (first) await authClient.organization.setActive({ organizationId: first.id });
    })();
  }, [session, tenantId]);

  // Tenant name for the printed ticket (cached; refreshed when online).
  useEffect(() => {
    if (!session || !tenantId || ready !== sessionKey || typeof navigator === "undefined") return;
    let alive = true;
    setTenantName(localStorage.getItem(`pos:tenant-name:${tenantId}`) ?? undefined);
    if (!navigator.onLine) return;
    void authClient.organization
      .list()
      .then((res) => {
        const orgs = res.data ?? [];
        const active = orgs.find((o) => o.id === tenantId);
        if (alive && active?.name) {
          setTenantName(active.name);
          try {
            localStorage.setItem(`pos:tenant-name:${tenantId}`, active.name);
          } catch {
            /* best-effort */
          }
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [session, tenantId, ready, sessionKey]);

  const showToast = useCallback((msg: string, kind: ToastKind = "success") => {
    setToast({ id: ++toastId.current, message: msg, kind });
  }, []);
  const closeToast = useCallback(() => setToast(null), []);

  const handleSignOut = useCallback(async () => {
    if (!local) return;
    await safeTransition(local.db, {
      state: state => { setIntent("logout"); setTransition(state); },
      flush: async () => { await stopSync(); if (tenantId) await pushNow(local.db, tenantId, { force: true }); },
      finish: async () => {
        const result = await authClient.signOut({ fetchOptions: { timeout: 15_000 } });
        if (result.error) throw new Error("No se pudo cerrar la sesión del servidor");
        sessionStorage.removeItem("pos:member-role");
        await clearLocalBusinessData(local.db);
        setRecoveryNeeded(false);
        setReady(null);
        setTenantName(undefined);
        localStorage.removeItem("pos:tenant-name");
        if (tenantId) localStorage.removeItem(`pos:tenant-name:${tenantId}`);
      },
    });
  }, [local, tenantId]);

  const reauthenticate = useCallback(async () => {
    localStorage.setItem("pos:reauth", "1");
    setReauth(true);
    setReady(null);
    if (local) await sealLocal(local.db);
    await stopSync();
  }, [local]);

  const onMutated = useCallback(() => {
    setRefreshToken((n) => n + 1);
    // badge refresh only — pushes happen from useSale().commit / reconnect /
    // manual retry (D2-5), so a catalog write never races the badge
    if (local && tenantId) void refreshSyncStatus(local.db, tenantId);
  }, [local, tenantId]);

  /* ---------------------------------------------------------------- */
  /* Datadir upgrade (D2-8): flush old queue → switch → rehydrate      */
  /* ---------------------------------------------------------------- */

  const retryUpgrade = useCallback(async () => {
    if (!local || !tenantId) return;
    await safeTransition(local.db, {
      state: state => { setIntent("upgrade"); setTransition(state); },
      flush: async () => { await stopSync(); await pushNow(local.db, tenantId, { force: true }); },
      finish: async () => {
        const handle = await switchToCurrentDatadir({ prepare: async candidate => {
          await claimLocal(candidate.db, tenantId);
          await rehydrateFromServer(candidate.db, tenantId);
        } });
        upgradeRef.current = "done";
        setReady(null);
        setLocal(handle);
        setRefreshToken(n => n + 1);
      },
    });
  }, [local, tenantId]);

  useEffect(() => {
    if (!local || !tenantId || ready !== sessionKey || upgradeRef.current !== "idle") return;
    upgradeRef.current = "running";
    let alive = true;
    void (async () => {
      try {
        const plan = await planBoot();
        if (plan.upgradeFrom === null) {
          if (alive) upgradeRef.current = "done";
          return;
        }
        if (alive) await retryUpgrade();
      } catch {
        if (alive) {
          upgradeRef.current = "done";
          setTransition({ phase: "blocked", message: "No se pudo comprobar la actualización. La base anterior sigue protegida." });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [local, tenantId, ready, sessionKey, retryUpgrade]);

  // E2E/test hooks: forced push + forced double-push (D2-9)
  useEffect(() => {
    if (!local || !tenantId || ready !== sessionKey || transition.phase !== "idle") return;
    const w = window as unknown as {
      __pos?: {
        pushNow: () => Promise<void>;
        repushSynced: () => Promise<unknown>;
        retryPoison: () => Promise<number>;
      };
    };
    w.__pos = {
      pushNow: () => pushNow(local.db, tenantId, { force: true }),
      repushSynced: () => repushSynced(local.db, tenantId),
      retryPoison: () => retryPoison(local.db, tenantId),
    };
    return () => {
      delete w.__pos;
    };
  }, [local, tenantId, ready, sessionKey, transition.phase]);

  if (secondTab) {
    return (
      <div className="notice-screen" data-testid="second-tab-notice">
        <h1>NEXORA ya está abierto</h1>
        <p className="muted">
          Este dispositivo permite una sola pestaña con la caja abierta.
          Cerrá la otra pestaña para continuar.
        </p>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="notice-screen" data-testid="boot-error">
        <h1>No se pudo abrir la base local</h1>
        <p className="muted">
          Cerrá otras pestañas de la caja y recargá la página.
        </p>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="notice-screen" data-testid="booting">
        <p>Cargando…</p>
      </div>
    );
  }

  if (reauth) return <Login recovery onAuthenticated={() => {
    localStorage.removeItem("pos:reauth");
    window.location.reload();
  }} />;

  if (transition.phase !== "idle") return (
    <div className="notice-screen" data-testid={`${intent}-${transition.phase}`}>
      <div className="card transition-card" role="status" aria-live="polite" aria-busy={transition.phase === "busy"}>
        <h1>{transition.phase === "busy" ? "Protegiendo tus cambios…" : "Tus datos siguen protegidos"}</h1>
        <p className="muted">{transition.message ?? "Esperando confirmación del servidor antes de continuar."}</p>
        {transition.pending !== undefined && <p data-testid="protected-pending">{transition.pending} registros o snapshots sin confirmar</p>}
        <button className="btn primary" data-testid="transition-retry" disabled={transition.phase === "busy"}
          onClick={() => void (intent === "logout" ? handleSignOut() : retryUpgrade())}>Reintentar sincronizar</button>
        <button className="btn ghost" data-testid="reauthenticate" disabled={transition.phase === "busy"}
          onClick={() => void reauthenticate()}>Volver a ingresar sin borrar datos</button>
      </div>
    </div>
  );
  if (!session) return <Login recovery={recoveryNeeded} />;
  if (!local) {
    return (
      <div className="notice-screen" data-testid="booting">
        <p>Cargando base local…</p>
      </div>
    );
  }
  if (!tenantId) {
    return (
      <div className="notice-screen" data-testid="no-tenant">
        <h1>Sin organización activa</h1>
        <p className="muted">
          No tenés una tienda asignada o la sesión no tiene organización activa.
          Salí y volvé a ingresar.
        </p>
        <button className="btn ghost" onClick={() => void handleSignOut()}>
          Salir
        </button>
      </div>
    );
  }

  if (accessError) {
    return (
      <div className="notice-screen" data-testid="access-blocked">
        <div>
          <h1>Base local protegida</h1>
          <p className="muted" role="alert">{accessError}</p>
          <button
            className="btn ghost"
            data-testid="reauthenticate"
            onClick={() => void reauthenticate()}
          >
            Volver a ingresar sin borrar datos
          </button>
        </div>
      </div>
    );
  }

  if (ready !== sessionKey) {
    return (
      <div className="notice-screen" data-testid="local-unlocking">
        <p>Comprobando la base protegida…</p>
      </div>
    );
  }

  return (
    <>
      <AppShell key={`${tenantId}:${session.user.id}`} db={local.db} tenantId={tenantId} user={session.user} tenantName={tenantName}
        tab={tab} refreshToken={refreshToken} onNavigate={setTab} onSignOut={handleSignOut}
        onTicket={id => { setPendingTicketId(id); setTab("tickets"); }}
        onVariant={id => { setPendingVariantId(id); setTab("catalog"); }}>

        {sync.lastSync !== null && (
          <div className="sync-meta" data-testid="last-sync">
            Última sync{" "}
            {new Date(sync.lastSync).toLocaleTimeString("es-CO", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}

        {sync.error && (
          <div className="sync-error-row" data-testid="sync-error">
            <span>Error de sync: {sync.error}</span>
            <button
              className="btn small"
              data-testid="sync-retry"
              onClick={() => void pushNow(local.db, tenantId, { force: true })}
            >
              Reintentar
            </button>
          </div>
        )}

        {sync.poison > 0 && (
          <div className="sync-poison-row" data-testid="sync-poison">
            <span>
              {sync.poison} cambios requieren revisión. Siguen guardados; no se descartan.
            </span>
            <button
              className="btn small"
              data-testid="sync-poison-retry"
              onClick={() => void retryPoison(local.db, tenantId)}
            >
              Reintentar tras corregir
            </button>
          </div>
        )}

        <main className="app-main">
        {tab === "credito" && (
          <Credito
            db={local.db}
            tenantId={tenantId}
            refreshToken={refreshToken}
            userId={session.user.id}
            tenantName={tenantName}
            showToast={showToast}
            onMutated={onMutated}
          />
        )}
        {tab === "dashboard" && (
          <Dashboard
            db={local.db}
            tenantId={tenantId}
            refreshToken={refreshToken}
            onNavigate={(t) => setTab(t)}
          />
        )}
        {tab === "sale" && (
          <Sale
            userId={session.user.id}
            db={local.db}
            tenantId={tenantId}
            tenantName={tenantName}
            refreshToken={refreshToken}
            showToast={showToast}
            onCommitted={onMutated}
            pendingProduct={pendingProduct}
            onPendingProductUsed={consumeProduct}
          />
        )}
        {tab === "catalog" && (
          <Catalog
            pendingVariantId={pendingVariantId}
            onPendingVariantUsed={consumeVariant}
            db={local.db}
            tenantId={tenantId}
            refreshToken={refreshToken}
            showToast={showToast}
            onMutated={onMutated}
          />
        )}
        {tab === "tickets" && (
          <Tickets
            userId={session.user.id}
            db={local.db}
            tenantId={tenantId}
            refreshToken={refreshToken}
            tenantName={tenantName}
            showToast={showToast}
            onMutated={onMutated}
            pendingTicketId={pendingTicketId}
            onPendingTicketUsed={consumeTicket}
            onOpenAccount={() => setTab("credito")}
          />
        )}
        {tab === "arqueo" && (
          <Arqueo
            actorId={session.user.id}
            actorName={session.user.name}
            db={local.db}
            tenantId={tenantId}
            refreshToken={refreshToken}
            showToast={showToast}
            onMutated={onMutated}
          />
        )}
        {tab === "reports" && (
          <Reports
            db={local.db}
            tenantId={tenantId}
            refreshToken={refreshToken}
            tenantName={tenantName}
          />
        )}
        </main>
      </AppShell>

      {paletteOpen && (
        <CommandPalette
          db={local.db}
          tenantId={tenantId}
          onClose={() => setPaletteOpen(false)}
          onNavigate={(t) => setTab(t)}
          onPickProduct={(item) => {
            setPendingProduct(item);
            setTab("sale");
          }}
          onPickTicket={(t) => {
            setPendingTicketId(t.id);
            setTab("tickets");
          }}
        />
      )}

      {toast && <Toast key={toast.id} toast={toast} onClose={closeToast} />}
    </>
  );
}
