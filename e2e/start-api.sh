#!/bin/sh
# E2E API bootstrap: fresh e2e database → schema → auth tables → seed → serve.
# Runs as the Playwright webServer command for the API (order-independent:
# the DB is prepared HERE, so it does not matter whether global setup or the
# web server starts first).
set -e

ADMIN_URL="postgres://esteban@127.0.0.1:5432/postgres"
DB_NAME="pos_piloto_e2e"
DB_URL="${DATABASE_URL:-postgres://esteban@127.0.0.1:5432/${DB_NAME}}"

echo "[e2e] recreating database ${DB_NAME}"
psql "$ADMIN_URL" -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)" -c "CREATE DATABASE ${DB_NAME}" >/dev/null

echo "[e2e] drizzle-kit push (business schema)"
DATABASE_URL="$DB_URL" pnpm --filter @pos/api exec drizzle-kit push >/dev/null

echo "[e2e] seed (owner + org + demo catalog + open shift)"
DATABASE_URL="$DB_URL" \
  SEED_OWNER_EMAIL="owner@demo.test" \
  SEED_OWNER_PASSWORD="demo12345" \
  pnpm --filter @pos/api exec tsx src/cli/seed.ts

echo "[e2e] starting API on :3000"
DATABASE_URL="$DB_URL" exec pnpm --filter @pos/api exec tsx src/server.ts
