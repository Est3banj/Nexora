import { useCallback, useEffect, useRef, useState } from "react";
import { activeOrgId, authClient } from "./auth";
import type { LocalHandle } from "./db/pglite";
import { getLocalDb, planBoot, switchToCurrentDatadir } from "./db/instance";
import {
  clearLocalBusinessData,
  isLocalCacheEmpty,
  unsyncedCount,
} from "./db/local";
import {
  discardPoison,
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

type Tab = "dashboard" | "sale" | "catalog" | "tickets" | "arqueo" | "reports";

/** Flush the OLD datadir queue (D2-8: never silently drop local-only data). */
async function tryFlush(handle: LocalHandle, tenantId: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  await pushNow(handle.db, tenantId, { force: true });
  return (await unsyncedCount(handle.db, tenantId)) === 0;
}

export default function App() {
  const { data: session, isPending } = authClient.useSession();
  const [local, setLocal] = useState<LocalHandle | null>(null);
  const [secondTab, setSecondTab] = useState(false);
  const [bootError, setBootError] = useState(false);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [toast, setToast] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [tenantName, setTenantName] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem("pos:tenant-name") ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [upgrade, setUpgrade] = useState<{
    phase: "idle" | "blocked" | "switching";
    pending?: number;
  }>({ phase: "idle" });
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

  // Sync engine: crash recovery (in_flight→pending), live status, and the
  // boot/reconnect auto-push. Re-runs after a datadir switch too (D2-5).
  useEffect(() => {
    if (!local || !tenantId) return;
    void initSync(local.db, tenantId);
  }, [local, tenantId]);

  // D4-4 first-boot / post-wipe rehydrate: empty local cache against a
  // populated server must pull truth BEFORE the first sale (ticket_no
  // sequence + catalog). No-op for a brand-new empty tenant.
  // Bumps refreshToken so Sale/Catalog/Tickets re-query after the pull —
  // otherwise a fresh device stays on the empty state forever.
  useEffect(() => {
    if (!local || !tenantId) return;
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
  }, [local, tenantId]);

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
    if (!session || !tenantId || typeof navigator === "undefined") return;
    if (!navigator.onLine) return;
    void authClient.organization
      .list()
      .then((res) => {
        const orgs = res.data ?? [];
        const active = orgs.find((o) => o.id === tenantId) ?? orgs[0];
        if (active?.name) {
          setTenantName(active.name);
          try {
            localStorage.setItem("pos:tenant-name", active.name);
          } catch {
            /* best-effort */
          }
        }
      })
      .catch(() => {});
  }, [session, tenantId]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  // D4-4 sign-out: best-effort flush → wipe local business rows → end session.
  // Next sign-in (any tenant) starts from an empty cache + first-boot rehydrate.
  const handleSignOut = useCallback(async () => {
    if (local && tenantId) {
      try {
        await pushNow(local.db, tenantId, { force: true });
      } catch {
        /* offline — wipe anyway; unsynced rows are lost by design on logout */
      }
    }
    if (local) {
      try {
        await clearLocalBusinessData(local.db);
      } catch {
        /* best-effort */
      }
    }
    try {
      localStorage.removeItem("pos:tenant-name");
    } catch {
      /* best-effort */
    }
    await authClient.signOut();
  }, [local, tenantId]);

  const onMutated = useCallback(() => {
    setRefreshToken((n) => n + 1);
    // badge refresh only — pushes happen from useSale().commit / reconnect /
    // manual retry (D2-5), so a catalog write never races the badge
    if (local && tenantId) void refreshSyncStatus(local.db, tenantId);
  }, [local, tenantId]);

  /* ---------------------------------------------------------------- */
  /* Datadir upgrade (D2-8): flush old queue → switch → rehydrate      */
  /* ---------------------------------------------------------------- */

  const performSwitch = useCallback(async () => {
    if (!tenantId) return;
    setUpgrade({ phase: "switching" });
    try {
      const handle = await switchToCurrentDatadir();
      setLocal(handle);
      try {
        const result = await rehydrateFromServer(handle.db, tenantId);
        if (result.inserted > 0) setRefreshToken((n) => n + 1);
      } catch {
        showToast("Catálogo local no pudo actualizarse — reintentá más tarde");
      }
      upgradeRef.current = "done";
      setUpgrade({ phase: "idle" });
    } catch {
      upgradeRef.current = "done";
      setUpgrade({ phase: "idle" });
      showToast("No se pudo abrir la nueva base local");
    }
  }, [tenantId, showToast]);

  const retryUpgrade = useCallback(async () => {
    if (!local || !tenantId) return;
    setUpgrade({ phase: "switching" });
    const flushed = await tryFlush(local, tenantId);
    if (flushed) {
      await performSwitch();
      return;
    }
    const left = await unsyncedCount(local.db, tenantId);
    if (left === 0) await performSwitch();
    else setUpgrade({ phase: "blocked", pending: left });
  }, [local, tenantId, performSwitch]);

  useEffect(() => {
    if (!local || !tenantId || upgradeRef.current !== "idle") return;
    upgradeRef.current = "running";
    let alive = true;
    void (async () => {
      try {
        const plan = await planBoot();
        if (plan.upgradeFrom === null) {
          if (alive) upgradeRef.current = "done";
          return;
        }
        const left = await unsyncedCount(local.db, tenantId);
        if (!alive) return;
        if (left > 0) {
          await tryFlush(local, tenantId);
          const after = await unsyncedCount(local.db, tenantId);
          if (!alive) return;
          if (after > 0) {
            setUpgrade({ phase: "blocked", pending: after });
            return;
          }
        }
        await performSwitch();
      } catch {
        if (alive) {
          upgradeRef.current = "done";
          setUpgrade({ phase: "idle" });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [local, tenantId, performSwitch]);

  // E2E/test hooks: forced push + forced double-push (D2-9)
  useEffect(() => {
    if (!local || !tenantId) return;
    const w = window as unknown as {
      __pos?: {
        pushNow: () => Promise<void>;
        repushSynced: () => Promise<unknown>;
        discardPoison: () => Promise<number>;
      };
    };
    w.__pos = {
      pushNow: () => pushNow(local.db, tenantId, { force: true }),
      repushSynced: () => repushSynced(local.db, tenantId),
      discardPoison: () => discardPoison(local.db, tenantId),
    };
    return () => {
      delete w.__pos;
    };
  }, [local, tenantId]);

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

  if (!session) return <Login />;
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

  if (upgrade.phase === "blocked") {
    return (
      <div className="notice-screen" data-testid="upgrade-blocked">
        <div>
          <h1>Sincronización pendiente</h1>
          <p className="muted">
            Hay <strong data-testid="upgrade-pending">{upgrade.pending ?? 0}</strong>{" "}
            cambios sin sincronizar en la versión anterior de la base. Conectate
            a internet y reintentá para no perderlos.
          </p>
          <button
            className="btn primary"
            data-testid="upgrade-retry"
            onClick={() => void retryUpgrade()}
          >
            Reintentar sincronizar
          </button>
          <button
            className="btn ghost"
            data-testid="upgrade-continue"
            onClick={() => void performSwitch()}
          >
            Continuar sin sincronizar
          </button>
        </div>
      </div>
    );
  }

  if (upgrade.phase === "switching") {
    return (
      <div className="notice-screen" data-testid="upgrade-switching">
        <p>Actualizando la base local…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="app-frame">
        <header className="app-header">
          <span className="brand"><img src="/icon-192.png" alt="" className="brand-logo" /> NEXORA</span>
          <span
            className={`net-status ${sync.online ? "net-online" : "net-offline"}`}
            data-testid="net-status"
          >
            {sync.online ? "en línea" : "sin conexión"}
          </span>
          <span
            className={`badge ${sync.pending > 0 ? "badge-pending" : "badge-ok"}`}
            data-testid="pending-badge"
            title="Mutaciones pendientes de sincronizar"
          >
            {sync.pending > 0 ? `${sync.pending} pendientes` : "sinc."}
          </span>
          <button
            className="btn ghost small"
            data-testid="sign-out"
            onClick={() => void handleSignOut()}
          >
            Salir
          </button>
        </header>

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
              {sync.poison} cambio con error permanente (no se reintentará)
            </span>
            <button
              className="btn small danger"
              data-testid="sync-discard"
              onClick={() => void discardPoison(local.db, tenantId)}
            >
              Descartar
            </button>
          </div>
        )}

        <main className="app-main">
        {tab === "dashboard" && (
          <Dashboard
            db={local.db}
            tenantId={tenantId}
            refreshToken={refreshToken}
          />
        )}
        {tab === "sale" && (
          <Sale
            db={local.db}
            tenantId={tenantId}
            refreshToken={refreshToken}
            showToast={showToast}
            onCommitted={onMutated}
          />
        )}
        {tab === "catalog" && (
          <Catalog
            db={local.db}
            tenantId={tenantId}
            refreshToken={refreshToken}
            showToast={showToast}
            onMutated={onMutated}
          />
        )}
        {tab === "tickets" && (
          <Tickets
            db={local.db}
            tenantId={tenantId}
            refreshToken={refreshToken}
            tenantName={tenantName}
            showToast={showToast}
            onMutated={onMutated}
          />
        )}
        {tab === "arqueo" && (
          <Arqueo
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
          />
        )}
        </main>
      </div>

      <nav className="tabbar">
        <button
          className={tab === "dashboard" ? "active" : ""}
          data-testid="tab-dashboard"
          onClick={() => setTab("dashboard")}
        >
          Números
        </button>
        <button
          className={tab === "sale" ? "active" : ""}
          data-testid="tab-sale"
          onClick={() => setTab("sale")}
        >
          Venta
        </button>
        <button
          className={tab === "catalog" ? "active" : ""}
          data-testid="tab-catalog"
          onClick={() => setTab("catalog")}
        >
          Catálogo
        </button>
        <button
          className={tab === "tickets" ? "active" : ""}
          data-testid="tab-tickets"
          onClick={() => setTab("tickets")}
        >
          Tickets
        </button>
        <button
          className={tab === "arqueo" ? "active" : ""}
          data-testid="tab-arqueo"
          onClick={() => setTab("arqueo")}
        >
          Caja
        </button>
        <button
          className={tab === "reports" ? "active" : ""}
          data-testid="tab-reports"
          onClick={() => setTab("reports")}
        >
          Reportes
        </button>
      </nav>

      {toast && (
        <div className="toast" data-testid="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
