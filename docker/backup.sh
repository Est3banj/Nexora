#!/bin/sh
# Skeleton — D4-6 (nightly backup + restore drill).
# Nightly pg_dump -Fc → /backups, keep 14 days.
set -e

: "${DB_HOST:=db}"
: "${DB_USER:=pos}"
: "${DB_NAME:=pos}"
: "${KEEP:=14}"

while ! pg_isready -h "$DB_HOST" -U "$DB_USER"; do
  sleep 2
done

STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="/backups/${DB_NAME}-${STAMP}.dump"

pg_dump -h "$DB_HOST" -U "$DB_USER" -Fc -f "$FILE" "$DB_NAME"
echo "[backup] wrote $FILE"

# keep last KEEP dumps
ls -1t /backups/*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old"
  echo "[backup] pruned $old"
done
