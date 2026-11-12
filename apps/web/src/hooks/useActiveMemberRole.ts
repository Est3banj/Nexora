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
      const data = JSON.parse(sessionStorage.getItem(CACHE) ?? "null");
      if (key && data?.key === key && valid(data.role)) cached = data;
      else sessionStorage.removeItem(CACHE);
    } catch { sessionStorage.removeItem(CACHE); }
    setValue(cached);
    if (key && tenantId && online) {
      void authClient.organization.getActiveMemberRole({ query: { organizationId: tenantId } }).then(result => {
        if (!alive) return;
        if (result.error || !valid(result.data?.role)) {
          setValue(null);
          sessionStorage.removeItem(CACHE);
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
