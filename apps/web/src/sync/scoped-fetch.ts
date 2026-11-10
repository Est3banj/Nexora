/** Session chooses the tenant. This header is only a precondition: the server
 * rejects a stale client rather than applying A's offline work in B's session. */
export function scopedFetch(tenant: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-nexora-tenant", tenant);
  return fetch(path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15_000) });
}
