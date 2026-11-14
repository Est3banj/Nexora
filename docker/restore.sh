#!/bin/sh
# NEXORA — restore a dump into a SEPARATE database (Partition B · deploy prep).
# STATUS: prepared, deploy UNVERIFIED (never executed against a real DB).
#
# Usage:
#   restore.sh <dump-file>                            # → ${DB_NAME}_restore
#   restore.sh <dump-file> --into other_db
#   restore.sh <dump-file> --into pos --destroy-live  # LIVE target, typed confirmation
#
# Rules:
#   * Default target is a SEPARATE database (${DB_NAME}_restore), so a drill
#     can never touch production data.
#   * Touching the LIVE database requires ALL of: `--destroy-live`,
#     `--confirm`, an interactive TTY, and typing the target name. A flag
#     alone is not enough. (This is a guardrail against accidents, not a
#     security boundary — anyone who can run this already has the DB role.)
#   * Every run requires `--confirm`: restore is a manual, deliberate
#     operation, never part of a cron job.
#   * PGPASSWORD comes from the environment only (never argv).
set -eu

: "${DB_HOST:=db}"
: "${DB_PORT:=5432}"
: "${DB_USER:=pos}"
: "${DB_NAME:=pos}"
: "${RESTORE_DB:=${DB_NAME}_restore}"

FILE=""
TARGET="$RESTORE_DB"
DESTROY_LIVE=0
CONFIRM=0

while [ $# -gt 0 ]; do
  case "$1" in
    --into)
      TARGET="${2:?--into needs a database name}"
      shift 2
      ;;
    --destroy-live) DESTROY_LIVE=1; shift ;;
    --confirm) CONFIRM=1; shift ;;
    -h|--help)
      echo "usage: restore.sh <dump-file> [--into <db>] [--destroy-live] [--confirm]"
      exit 0
      ;;
    -*)
      echo "[restore] unknown flag: $1" >&2
      exit 2
      ;;
    *)
      FILE="$1"
      shift
      ;;
  esac
done

if [ -z "$FILE" ]; then
  echo "usage: restore.sh <dump-file> [--into <db>] [--destroy-live] [--confirm]" >&2
  exit 2
fi
if [ ! -f "$FILE" ]; then
  echo "[restore] dump not found: $FILE" >&2
  exit 1
fi
if [ "$CONFIRM" != 1 ]; then
  echo "[restore] refusing to run without --confirm (this REPLACES the target's public schema)." >&2
  exit 2
fi

# Identifiers go into SQL: allow only [A-Za-z0-9_].
case "$TARGET" in
  ''|*[!A-Za-z0-9_]*)
    echo "[restore] invalid database name: $TARGET" >&2
    exit 2
    ;;
esac

if [ "$TARGET" = "$DB_NAME" ]; then
  if [ "$DESTROY_LIVE" != 1 ]; then
    echo "[restore] refusing: '$TARGET' is the LIVE database." >&2
    echo "[restore] Restore into a separate database (default: ${DB_NAME}_restore)," >&2
    echo "[restore] or pass --destroy-live if you really mean to replace live data." >&2
    exit 3
  fi
  if [ ! -t 0 ]; then
    echo "[restore] LIVE target requires an interactive TTY (stdin is not a terminal)." >&2
    exit 4
  fi
fi

echo "[restore] dump:    $FILE"
echo "[restore] target:  $TARGET @ $DB_HOST:$DB_PORT (user $DB_USER)"
if [ "$TARGET" = "$DB_NAME" ]; then
  echo "[restore] !! LIVE DATABASE — existing rows in public.* will be replaced."
  printf "[restore] type the target database name to continue: "
  read -r TYPED
  if [ "$TYPED" != "$TARGET" ]; then
    echo "[restore] confirmation failed (typed '$TYPED')" >&2
    exit 4
  fi
fi

psql_admin() {
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -v ON_ERROR_STOP=1 "$@"
}

# Create the target database when it does not exist yet.
if ! psql_admin -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$TARGET'" | grep -q 1; then
  echo "[restore] creating database $TARGET"
  psql_admin -d postgres -c "CREATE DATABASE \"$TARGET\""
fi

echo "[restore] restoring into $TARGET (objects are dropped and recreated) ..."
# --clean --if-exists        → drop what exists first (destructive to TARGET only)
# --no-owner --no-privileges → portable across roles and hosts
set +e
pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$TARGET" \
  --clean --if-exists --no-owner --no-privileges "$FILE"
RC=$?
set -e
# pg_restore: 0 = OK, 1 = warnings (ignored objects), >= 2 = real errors.
if [ "$RC" -ge 2 ]; then
  echo "[restore] FAILED: pg_restore exited with $RC — target may be half-restored." >&2
  exit "$RC"
fi
if [ "$RC" -eq 1 ]; then
  echo "[restore] pg_restore finished with warnings (exit 1)"
else
  echo "[restore] pg_restore finished (exit 0)"
fi

TABLES=$(psql_admin -d "$TARGET" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
echo "[restore] done: $TARGET now has $TABLES table(s) in public."
echo "[restore] verify the data BEFORE pointing anything at this database."
