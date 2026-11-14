# docker / ops

Deploy scaffolding lives here:

| Archivo | Qué es |
|---|---|
| `compose.yml` | template de producción: `caddy` + `api` + `db` + `backup` (profile) |
| `Caddyfile` | TLS + SPA + proxy exclusivo de `/api/*` |
| `Dockerfile.api` | imagen de la API (tsx, sin paso de build) |
| `.env.example` | **nombres** de variables (`NEXORA_*`), sin valores |
| `backup.sh` | `pg_dump` nocturno (env atómico, retención, rclone comentado) |
| `restore.sh` | restore en base **separada**, confirmación explícita para la viva |

**Estado: preparado, build/deploy SIN VERIFICAR.** La guía completa —
orden de primer arranque, deploy/rollback, health, runbook de sync,
monitoreo y backups — está en [`../DEPLOY.md`](../DEPLOY.md).

## Provisionar el primer dueño (sin contraseña en el argv)

```sh
# interactivo: lee la contraseña sin eco, no la escribe en ningún archivo
pnpm --filter @pos/api owner-provision
# validar sin tocar la base
pnpm --filter @pos/api owner-provision -- --dry-run
```

`tenant-create` acepta `--password <valor>` y por eso deja la contraseña en
el argv (visible con `ps` y en el historial). Úsalo sólo en laboratorio.

## Founder CLI (degradation path — D4-1)

Runs against the API's database (`DATABASE_URL`); no HTTP server required.
Equivalent records to the founder web plane (shared `src/founder/service.ts`).

```bash
# create a tenant + its first user (owner membership + audit_log entry)
pnpm --filter @pos/api tenant-create -- \
  --name "Tienda Granizados" \
  --email shop@tienda.co \
  --password "solo-laboratorio" \
  [--slug tienda-granizados] \
  [--actor founder@example.com]

# per-tenant sync status: last_sync (ledger aplicado) + conteos por tenant,
# nunca mezclados entre tenants, sólo metadatos (sin filas de negocio)
pnpm --filter @pos/api sync-status

# nightly pg_dump inventory (BACKUPS_DIR defaults to /backups)
BACKUPS_DIR=/backups pnpm --filter @pos/api backup-status
```

Equivalent with the dockerized API:

```sh
docker compose exec api pnpm sync-status
docker compose exec api pnpm owner-provision   # ← preferido en producción
docker compose --profile backup run --rm backup
```

`user.platformAdmin` (plano fundador: `POST /api/founder/tenants`) se
provisiona **a mano y de forma deliberada**, nunca por la UI de un tenant —
ver `../DEPLOY.md` §3.
