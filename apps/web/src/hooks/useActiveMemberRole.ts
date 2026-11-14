import { useEffect, useState } from "react";
import { authClient } from "../auth";

const CACHE = "pos:member-role";
type Role = "owner" | "member" | "admin";
const valid = (role: unknown): role is Role => role === "owner" || role === "member" || role === "admin";

/** UI hint only. Never grants server authority; unknown membership fails closed. */
export function useActiveMemberRole(tenantId: string | null, userId: string | null, online: boolean) {
  const key = tenantId && userId ? `${tenantId}:${userId}` : null;
  const [value, setValue] = useState<{ key: string; role: Role } | null>(null);
  useEffect(() => {
    let alive = true;
    let cached: { key: string; role: Role } | null = null;
    try {
      const data = JSON.parse(sessionStorage.getItem(CACHE) ?? "null") as { key?: unknown; role?: unknown } | null;
      if (data && typeof data === "object") {
        if (!valid(data.role)) {
          // Corrupt entry — never trust it.
          sessionStorage.removeItem(CACHE);
        } else if (key === null) {
          // No identity YET (session still resolving on boot/reload): keep
          // the entry. roles-admin 5.2 lifted this hook to App, so it now
          // runs during the pending-session window — dropping the hint here
          // would destroy a verified role on every OFFLINE reload (the
          // refetch cannot run to restore it). It is re-checked the moment
          // an identity is known, below.
        } else if (data.key === key) {
          cached = { key, role: data.role };
        } else {
          // Different tenant/user — a stale hint must never resurface
          // (modernization: "tenant change discards prior cached owner").
          sessionStorage.removeItem(CACHE);
        }
      }
    } catch { sessionStorage.removeItem(CACHE); }
    setValue(cached);
    if (key && tenantId && online) {
      void authClient.organization.getActiveMemberRole({ query: { organizationId: tenantId } }).then(result => {
        if (!alive) return;
        if (result.error || !valid(result.data?.role)) {
          // Refresh failed (rate-limit/5xx/transient): KEEP the last verified
          // hint for this identity — a transient error must not make the
          // owner's buttons vanish. Authority is enforced server-side regardless;
          // a definitive role change lands on the next successful refresh.
          if (!cached) {
            setValue(null);
            sessionStorage.removeItem(CACHE);
          }
          return;
        }
        const next = { key, role: result.data.role };
        setValue(next);
        sessionStorage.setItem(CACHE, JSON.stringify(next));
      }).catch(() => { /* Keep only this identity's previously verified offline UI hint. */ });
    }
    return () => { alive = false; };
  }, [key, tenantId, online]);
  return value?.key === key ? value.role : null;
}
