import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

/**
 * Better-auth browser client. Same-origin via the Vite dev proxy
 * (/api → API server), so cookies are first-party and the PWA keeps
 * working behind Caddy in D4 without CORS.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient()],
  fetchOptions: { timeout: 15_000 },
});

export type SessionLike = {
  session: {
    id: string;
    activeOrganizationId?: string | null;
  };
  user: { id: string; email: string; name: string };
};

/** better-auth 1.7 does not type activeOrganizationId (see apps/api auth.ts). */
export function activeOrgId(sessionData: unknown): string | null {
  const s = sessionData as { session?: { activeOrganizationId?: string | null } } | null;
  return s?.session?.activeOrganizationId ?? null;
}
