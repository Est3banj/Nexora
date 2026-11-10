# docker / ops

Deploy scaffolding lives here (`compose.yml`, `Caddyfile`, `Dockerfile.api`,
`backup.sh`) — fleshed out by D4-5/D4-6.

## Founder CLI (degradation path — D4-1)

Runs against the API's database (`DATABASE_URL`); no HTTP server required.
Equivalent records to the founder web plane (shared `src/founder/service.ts`).

```bash
# create a tenant + its first user (owner membership + audit_log entry)
pnpm --filter @pos/api tenant-create -- \
  --name "Tienda Granizados" \
  --email shop@tienda.co \
  --password "secret123" \
  [--slug tienda-granizados] \
  [--actor founder@example.com]

# per-tenant sync status: pending / errors / last sync — one row per tenant,
# counts never merged across tenants, metadata only (no business rows)
pnpm --filter @pos/api sync-status

# nightly pg_dump inventory (BACKUPS_DIR defaults to /backups)
BACKUPS_DIR=/backups pnpm --filter @pos/api backup-status
```

Equivalent with the dockerized API (after D4-5):

```sh
docker compose exec api pnpm tenant-create -- --name "…" --email "…" --password "…"
docker compose exec api pnpm sync-status
```
