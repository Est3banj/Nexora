import type { PGlite } from "@electric-sql/pglite";
import { sealLocal, unresolvedWork } from "../db/preservation";

export type TransitionState = { phase: "idle" | "busy" | "blocked"; message?: string; pending?: number };

/** Single-flight per database, not per React render. Fail closed and leave the
 * durable seal in place on every error. Only claimLocal may reopen writes. */
const running = new WeakMap<PGlite, Promise<void>>();
export function safeTransition(db: PGlite, deps: {
  flush: () => Promise<void>;
  finish: () => Promise<void>;
  state: (state: TransitionState) => void;
}): Promise<void> {
  const existing = running.get(db);
  if (existing) return existing;
  deps.state({ phase: "busy" });
  const task = (async () => {
    try {
      await sealLocal(db);
      await deps.flush();
      const pending = await unresolvedWork(db);
      if (pending) {
        const errors = await db.query<{ last_error: string }>("SELECT last_error FROM sync_log WHERE status<>'synced' AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1");
        const detail = errors.rows[0]?.last_error;
        deps.state({ phase: "blocked", pending, message: `Tus ventas y cambios siguen guardados en este dispositivo. Conectate y reintentá. Si venció la sesión, volvé a ingresar con el mismo comercio. Los errores permanentes requieren revisión; no se descartan.${detail ? ` Detalle: ${detail}` : ""}` });
        return;
      }
      await deps.finish();
      deps.state({ phase: "idle" });
    } catch (error) {
      deps.state({ phase: "blocked", message: `No se completó la salida o actualización. La base sigue protegida. Reintentá o volvé a ingresar con el mismo comercio. (${error instanceof Error ? error.message : "error"})` });
    }
  })().finally(() => running.delete(db));
  running.set(db, task);
  return task;
}
