#!/bin/sh
# NEXORA — nightly pg_dump (Partition B · deploy prep).
# STATUS: prepared, deploy UNVERIFIED (never executed against a real DB).
#
# Run it through compose (profile "backup") — see DEPLOY.md §Backups:
#   docker compose --profile backup run --rm backup
#
# Secrets: PGPASSWORD comes ONLY from the environment (compose `environment:`).
# Never pass it as an argument: argv is visible in `ps` on the host.
# Dump files are written with mode 600 (umask 077) and become visible only
# after a successful `mv` from a `.partial` temp file — a crash mid-dump
# never leaves a truncated file that looks like a good backup.
set -eu

: "${DB_HOST:=db}"
: "${DB_PORT:=5432}"
: "${DB_USER:=pos}"
: "${DB_NAME:=pos}"
: "${KEEP:=14}"
: "${BACKUP_DIR:=/backups}"

# PGPASSWORD is optional here: trust/password-less setups work without it.
# When set (by compose), pg_dump/pg_isready pick it up from the environment.

while ! pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" >/dev/null 2>&1; do
  echo "[backup] waiting for postgres at ${DB_HOST}:${DB_PORT} ..."
  sleep 2
done

STAMP="$(date +%Y%m%d-%H%M%S)"
FINAL="${BACKUP_DIR}/${DB_NAME}-${STAMP}.dump"
TMP="${FINAL}.partial"

# Clean up a partial dump on any exit path (INT/TERM/EXIT).
trap 'rm -f "$TMP"' EXIT INT TERM

umask 077
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Fc -f "$TMP"
# Atomic publish: readers only ever see a complete dump.
mv -f "$TMP" "$FINAL"
trap - EXIT INT TERM
echo "[backup] wrote $FINAL ($(wc -c < "$FINAL" | tr -d ' ') bytes)"

# Retention: keep the newest KEEP dumps of THIS database only.
ls -1t "${BACKUP_DIR}/${DB_NAME}"-*.dump 2>/dev/null |
  tail -n "+$((KEEP + 1))" |
  while read -r old; do
    rm -f "$old"
    echo "[backup] pruned $old"
  done

# ── Off-host copy (disabled by default) ────────────────────────────────────
# A backup that only lives on the same disk as the database is not a backup.
# Install rclone on the host, configure a remote (`rclone config`), then
# enable the block below and point RCLONE_REMOTE at it, e.g.
# RCLONE_REMOTE=s3:my-bucket/nexora
#
# if [ -n "${RCLONE_REMOTE:-}" ]; then
#   rclone copy --config /etc/rclone/rclone.conf "$FINAL" "${RCLONE_REMOTE}/"
#   echo "[backup] off-host copy done → ${RCLONE_REMOTE}/"
# fi
#
# Test the copy on its own first: `rclone lsf "${RCLONE_REMOTE}/"`.
