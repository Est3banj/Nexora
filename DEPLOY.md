# NEXORA — despliegue y operación (Partition B)

> **Estado: PREPARADO — build/deploy SIN VERIFICAR.**
> Todo lo que sigue es configuración, scripts y documentación escritos y
> verificados **estáticamente** (sintaxis, tipos, lint, suites de tests,
> chequeos cruzados de rutas/variables). **No** se ejecutó `docker build`,
> **no** se ejecutó `pnpm build`, **no** se corrió ninguna migración contra
> una base de datos real, **no** se levantó ningún servicio de producción ni
> se expuso ningún puerto. La primera máquina que levante esto es la tuya.
>
> Ver §12 para la lista exacta de lo verificado y de lo que sigue sin
> verificar.

Archivos de esta partición: `docker/compose.yml`, `docker/Caddyfile`,
`docker/Dockerfile.api`, `docker/.env.example`, `docker/backup.sh`,
`docker/restore.sh`, `.dockerignore`, `apps/api/src/db/init-baseline.ts`,
`apps/api/src/cli/owner-provision.ts`, más los cambios en `config.ts`,
`app.ts`, `server.ts`, `vite.config.ts` y `apps/web/package.json`.

---

## 1. Variables de entorno (solo nombres)

Plantilla: `docker/.env.example` → copiala a `docker/.env` y completala.
`docker/.env` está ignorado por git (`.gitignore: .env`) y excluido del
contexto de build (`.dockerignore`).

| Nombre | Quién lo lee | Requisito |
|---|---|---|
| `NEXORA_DB_USER` | compose (`db`, `api`, `backup`) | usuario de Postgres |
| `NEXORA_DB_PASSWORD` | compose (`db`, `api`, `backup`) | **requerido**; si lo ponés en `NEXORA_DATABASE_URL` debe ser URL-safe (`%40` para `@`, etc.) |
| `NEXORA_DB_NAME` | compose (`db`, `api`, `backup`) | nombre de la base |
| `NEXORA_DATABASE_URL` | API | **requerido**; `postgres://user:pass@db:5432/name` apuntando al servicio `db` de compose |
| `NEXORA_BETTER_AUTH_SECRET` | API | **requerido**; ≥ 32 caracteres. Generar: `openssl rand -base64 32` |
| `NEXORA_BETTER_AUTH_URL` | API | **requerido**; origen https público de la API (`https://pos.example.com`), sin path |
| `NEXORA_TRUSTED_ORIGINS` | API | **requerido**; orígenes https de la web, separados por coma. En producción **no** se agrega ninguno dev |

La API valida todo esto al arrancar (`apps/api/src/config.ts`): si falta
algo, o si hay un origen loopback/dev, **no arranca** y el mensaje dice
exactamente qué falta. `NODE_ENV=production` también obliga a que
`BETTER_AUTH_URL` sea `https://`.

---

## 2. Pre-vuelo (antes del primer arranque)

```sh
# 0. El árbol de trabajo tiene cambios sin commitear (roles-admin + esta
#    partición). NO hacer reset/commit/staging/push sin decidirlo.
git status

# 1. Completar el env
cp docker/.env.example docker/.env && $EDITOR docker/.env

# 2. Validar la interpolación de compose (sin levantar nada)
#    (el .env se carga solo desde el directorio del compose file: docker/.env)
docker compose -f docker/compose.yml config

# 3. Validar el Caddyfile (--entrypoint para no depender del ENTRYPOINT de la imagen)
docker compose -f docker/compose.yml run --rm --no-deps \
  --entrypoint caddy caddy validate \
  --config /etc/caddy/Caddyfile --adapter caddyfile

# 4. La web debe estar construida ANTES de levantar caddy (compose la
#    bind-mounta desde ../apps/web/dist)
pnpm --filter @pos/web build
test -f apps/web/dist/index.html && echo "web OK"

# 5. Chequear que el host resuelve el dominio que pusiste en el Caddyfile
```

---

## 3. Orden del PRIMER arranque

El orden importa: el baseline de base de datos lo corre la API, y el
dueño se crea después de que la API esté sana.

```sh
# 1. Base de datos
docker compose up -d db
docker compose ps   # db → healthy

# 2. API — acá ocurre el primer arranque real de schema:
#      ensureAuthTables() → initBaseline() → migraciones aditivas → listen
#    En los logs debe aparecer:
#      [baseline] first boot: business schema baseline applied (business-schema-v1)
#      [api] listening on :3000 (production)
docker compose up -d api
docker compose logs api | tail -30

# 3. Verificar salud (ver §6)
curl -fsS http://localhost:3000/api/health      # → 200 {"ok":true,...,"ready":true}
curl -fsS http://localhost:3000/api/health/live # → 200 {"ok":true,"live":true}

# 4. Web + proxy (ya construida en §2.4)
docker compose up -d caddy
curl -fsSk https://localhost/api/health          # vía Caddy

# 5. PRIMER DUEÑO — interactivo, contraseña sin eco, sin argv
#    (exec allocates a TTY by default; -it lo deja explícito: el script
#     exige un TTY real, en una pipe se niega a correr)
docker compose exec -it api pnpm owner-provision
#    (o en el host, con la consola: pnpm --filter @pos/api owner-provision)
#    Validar sin tocar la base:  pnpm --filter @pos/api owner-provision --dry-run

# 6. Ingresar a la web con ese usuario y verificar que abre el tenant.
```

**Nunca** crear el primer dueño con `tenant-create --password ...`: eso
deja la contraseña en el argv (visible con `ps` y en el historial del
shell). `tenant-create` queda como fallback de laboratorio.

### Provisionamiento de platform-admin (paso aparte, deliberado)

`platformAdmin` **no** es un rol de tenant: un owner nunca lo obtiene por
la UI. Si necesitás el plano fundador (`POST /api/founder/tenants`,
`GET /api/founder/sync-status`), hacerlo a mano, después de que el usuario
exista:

```sh
docker compose exec db psql -U "$NEXORA_DB_USER" -d "$NEXORA_DB_NAME" \
  -c "SELECT email, \"platformAdmin\" FROM \"user\" ORDER BY email;"

docker compose exec db psql -U "$NEXORA_DB_USER" -d "$NEXORA_DB_NAME" \
  -c "UPDATE \"user\" SET \"platformAdmin\" = true WHERE email = 'tu@email.com';"
```

Es una fila de usuario, no una migración: no toca schema ni datos de
negocio. Dejalo registrado quién y por qué (quien tiene platformAdmin crea
tenants para todos).

---

## 4. Despliegues y rollback

### Orden de despliegue: **API → web**

```sh
# API (schema aditivo + código)
docker compose build api
docker compose up -d api
curl -fsS http://localhost:3000/api/health   # espera 200 ready:true

# Web (build en el host; los archivos están bind-mounteados en caddy)
pnpm --filter @pos/web build
# Caddy lee de disco por request: no hace falta reiniciar nada.
# Si cambiaste el Caddyfile: docker compose restart caddy
```

### Rollback: **web primero, después API**

```sh
# 1. Web (stateless, se revierte reconstruyendo la versión anterior)
git checkout <commit-anterior> -- apps/web
pnpm --filter @pos/web build
# listo: caddy sirve el dist anterior

# 2. API sólo si el cambio de API es el problema
git checkout <commit-anterior> -- apps/api packages/shared
docker compose build api && docker compose up -d api
```

**Regla de schema:** las migraciones son **aditivas y hacia adelante**
(`IF NOT EXISTS`, sin down-migrations). Revertir el código de la API es
siempre seguro; **nunca** hay que revertir la base de datos. Si un deploy
posterior exige una columna nueva, el deploy anterior sigue funcionando
porque no la conoce.

---

## 5. Salud y readiness

| Endpoint | Qué responde | Cuándo usarlo |
|---|---|---|
| `GET /api/health` | **Readiness**: `200` con `{ok, live, ready, db, schema, ms}` si la DB responde **y** el schema está completo (`products`, `audit_log`, `user`); `503` con `db`/`schema` si no. Presupuesto 700 ms. | healthcheck del contenedor, `depends_on`, LB, monitoreo |
| `GET /api/health/live` | **Liveness**: `200` siempre, cero I/O. | distinguir "el proceso API murió" de "la DB no responde" |

En compose:

- `api` → `wget http://127.0.0.1:3000/api/health` (intervalo 15 s, `start_period` 60 s para dar tiempo a las migraciones)
- `db` → `pg_isready`
- `caddy` → endpoint admin `http://127.0.0.1:2019/config/`
- `caddy` arranca **recién** cuando `api` está `healthy`

Ambos endpoints están exentos del rate limit.

---

## 6. Runbook — dispositivo con ventas sin sincronizar

**Modelo (no negociable):** la cola de sync vive **en el dispositivo**
(PGlite local). El `sync_log` del servidor es el **ledger de aplicadas**
(`sync-apply.ts` escribe siempre `status='synced'`); una venta que todavía
no llegó **no existe en el servidor**, y por eso no hay query server-side
que la encuentre. Lo que sí hay: indicios.

1. **Síntoma en el dispositivo**
   - contador de pendientes / campana de alertas / fila «(pendiente de sync)»
   - detalle de sincronización con `last_error`
   - la app nunca muestra éxito de una venta que no quedó commiteada: el
     recibo sólo se emite después del commit durable.

2. **Diagnóstico en el dispositivo (sin tocar la base)**
   - Mantener el dispositivo **online**; el drain reintenta solo.
   - Estados de la cola (`packages/shared/src/mutations.ts`):
     `pending → in_flight → synced | failed → poison`.
   - `failed` se reintenta; un rechazo **determinista** pasa a `poison`
     a los 3 intentos y queda **aislado y visible** (nunca se borra).
   - Red/timeout/429/`db_error` **nunca** envenenan: son reintentables.

3. **Diagnóstico en el servidor**
   ```sh
   # Errores de sync en los logs de la API
   docker compose logs --since 24h api | grep -iE "sync|sale_rejected|conflict"

   # Estado por tenant (ledger aplicado: last_sync es lo que sirve)
   docker compose exec api pnpm sync-status

   # Snapshots subidos y sin commit (se purgan a los 7 días)
   docker compose exec db psql -U "$NEXORA_DB_USER" -d "$NEXORA_DB_NAME" \
     -c "SELECT tenant_id, operation_id, created_at
           FROM sync_sale_operations WHERE results IS NULL
          ORDER BY created_at;"

   # Conflictos rechazados quedan auditados
   docker compose exec db psql -U "$NEXORA_DB_USER" -d "$NEXORA_DB_NAME" \
     -c "SELECT tenant_id, actor, action, created_at, meta
           FROM audit_log ORDER BY created_at DESC LIMIT 20;"
   ```

4. **Qué NO hacer**
   - **Nunca** borrar/vaciar la cache local del dispositivo para «probar
     de nuevo»: las filas locales son evidencia y trabajo sin commitear
     (`PRESERVACION-LOCAL.md`). Borrar = pérdida de datos.
   - **Nunca** tocar `sync_sale_operations` / `sync_log` a mano.
   - **Nunca** reintentar un `poison` a ciegas: primero leer `last_error`
     y resolver la causa de contrato.

5. **Recuperación**
   - Dispositivo online + causa resuelta → la cola drena sola y el
     `last_sync` del tenant avanza (`pnpm sync-status`).
   - Snapshot expirado (>7 días): el cliente conserva el snapshot y vuelve
     a subir todas las partes; el servidor no re-aplica recibos ya
     aplicados (idempotencia por `client_uuid`).
   - Escalate: exportar **solo metadatos** (`last_error`, `status`,
     `attempts`, `client_uuid`, timestamps). Nunca payloads de negocio por
     canal de soporte.

Referencias: `SYNC-VENTAS-GRANDES.md`, `PRESERVACION-LOCAL.md`, `FIADO.md`.

---

## 7. Logs y rotación

- Los servicios loguean a **stdout**; compose los guarda con el driver
  `json-file` ya configurado en `docker/compose.yml`
  (`max-size: 10m`, `max-file: 5`) → rotación automática, sin ocupar el
  disco del host.
- Ver en vivo: `docker compose logs -f api`
- Recortar manualmente: `docker compose logs --since 1h api`
- Los archivos de backup tienen su propio ciclo: ver §9 (`KEEP=14`).

---

## 8. Monitoreo — sondas

| Sonda | Fuente | Alerta si |
|---|---|---|
| Readiness API | `GET /api/health` (interno o externo) | `503` o timeout > 2 min seguido |
| Liveness API | `GET /api/health/live` | no responde → el proceso está caído |
| Contenedores | `docker compose ps` | `api`/`db`/`caddy` `unhealthy` o `restarting` |
| Proxied | `https://<dominio>/api/health` | distinto de `200` (mira `schema` en el body: `incomplete` = schema de primer arranque no aplicado) |
| Disco | `df -h` + `docker system df` | backup volume `nexora_backups` creciendo sin límite |

Interpretación del body de `/api/health`:

- `db: "down"` → Postgres no responde (¿red, ¿contenedor caído, ¿credential?)
- `schema: "incomplete"` → la API está apuntando a una base sin baseline
  (¿otra base?, ¿el boot no corrió `initBaseline`?)
- `schema: "unknown"` + `db: "down"` → mismo caso, sin poder consultar

---

## 9. Backups y restore

### Backup (cron en el host)

`docker/compose.yml` define el servicio `backup` con **profile** (no corre
en `up` normal):

```sh
# manual
docker compose --profile backup run --rm backup

# cron nocturno (host) — 03:00, retención 14 dumps
# crontab -e
0 3 * * * cd /opt/pos-piloto/docker && docker compose --profile backup run --rm backup >> /var/log/nexora-backup.log 2>&1
```

`docker/backup.sh`:
- `PGPASSWORD` **sólo por entorno** (nunca en argv → invisible en `ps`);
- dump a `*.partial` + `mv` atómico → nunca queda un dump a medias
  publicado como bueno;
- `umask 077` → archivos `600`;
- retención `KEEP` (default 14), sólo de esa base;
- copia off-host **comentada** (ejemplo `rclone` al final del script) —
  un backup en el mismo disco que la base no es un backup.

### Restore (`docker/restore.sh`)

Por defecto restaura en una base **separada** (`${DB_NAME}_restore`), así
un drill nunca toca producción:

```sh
# drill habitual (restaura en ${NEXORA_DB_NAME}_restore, nunca en la viva)
docker compose --profile backup run --rm \
  -v ./restore.sh:/restore.sh:ro \
  --entrypoint /bin/sh backup \
  /restore.sh /backups/pos-20260101-030000.dump --confirm

# restaurar en la base VIVA: exige --destroy-live + --confirm + escribir el
# nombre de la base a mano en una TTY
docker compose --profile backup run --rm \
  -v ./restore.sh:/restore.sh:ro \
  --entrypoint /bin/sh backup \
  /restore.sh /backups/pos-20260101-030000.dump --destroy-live --confirm
```

Nunca corre en cron: `--confirm` es obligatorio.

---

## 10. Orden de actualizaciones (resumen)

| Paso | Orden |
|---|---|
| Primera puesta en marcha | db → api (baseline) → verificar `/api/health` → web → owner interactivo |
| Deploy normal | API → web |
| Rollback | web primero, API después; **el schema nunca se revierte** |
| Restore | drill en base separada; la base viva sólo con confirmación escrita |

---

## 11. Variables de runtime del contenedor API

Además de las `NEXORA_*`, `docker/compose.yml` fija:
`NODE_ENV=production`, `PORT=3000`. El `.env` de la raíz del repo **no**
se copia a la imagen (`.dockerignore`): en producción todo llega por
entorno real de compose.

---

## 12. Verificado / sin verificar

### Verificado en esta partición (sin build, sin red, sin DB real)

- `pnpm typecheck` → verde (shared, api, web)
- `pnpm lint` → verde
- `sh -n` y `bash -n` sobre `docker/backup.sh` y `docker/restore.sh`
- `docker/compose.yml` parseado como YAML (anker `logging` resuelto) e
  interpolado con un simulador propio: **0 errores** con valores sintéticos
  y **los 10 guards `${NEXORA_*:?…}`** saltan con un env vacío (nadie
  levanta la stack con defaults dev). `db` y `api` quedan **sin `ports:`**
  (no publicados).
- chequeo cruzado: las 7 variables `${NEXORA_*}` de `compose.yml` existen
  en `docker/.env.example` y viceversa; rutas referenciadas
  (`docker/Dockerfile.api`, `Caddyfile`, `backup.sh`, `restore.sh`,
  `apps/web/dist`, fuentes del `COPY` del Dockerfile) existen
- suites de tests, en orden:
  - typecheck ✓ · lint ✓
  - shared **50/50** ✓
  - web **154/154** ✓
  - api **263/263** ✓ (los 258 previos + 5 nuevos de `baseline-init.test.ts`)
  - E2E **69/69** con `E2E_API_PORT=3101 E2E_WEB_PORT=5181` ✓
- nuevo `apps/api/test/baseline-init.test.ts`: el `BASELINE_SQL` sobre una
  PGlite **vacía** crea las 15 tablas del baseline con columnas idénticas a
  las de drizzle-kit push, con los índices que necesitan los upserts, sin
  crear las tablas que pertenecen a migraciones posteriores, y
  `initBaseline()` es marker-gateado y no destructivo
- `owner-provision` probado en una **TTY real** (pty): las 5 preguntas se
  responden, el modo dry-run imprime el resumen y **la contraseña nunca
  aparece en la salida**; en pipe se niega con error y exit 1; `--dry-run`
  y el separador `--` de pnpm se manejan
- bug encontrado y arreglado en el camino: pnpm reenvía el separador `--`
  al script, y `parseTenantCreateArgs` lo rechazaba — el uso documentado
  `pnpm --filter @pos/api tenant-create -- --name …` **no funcionaba**.
  Ahora se saltea ese token (verificado: sigue rechazando argumentos basura
  y passwords cortos)
- el arranque real del E2E corrió `initBaseline()` contra Postgres
  (`pos_piloto_e2e`, creada limpia por `start-api.sh`): la fila
  `business-schema-v1` está en `schema_baseline`, con las 15 tablas y los
  índices del baseline presentes

### SIN VERIFICAR (requiere build + host, fuera de alcance)

- `docker build` de `Dockerfile.api` (incluye: que `pnpm install
  --frozen-lockfile --filter @pos/api...` resuelva y que `corepack prepare
  pnpm@9.15.9` funcione en `node:20-alpine`)
- `docker compose config` / `docker compose up` reales — **en esta máquina
  Docker no está instalado** (`/usr/local/bin/docker` es un symlink roto a
  `/Applications/Docker.app`, que no existe). Sustituído por parseo YAML +
  chequeo de variables; corrélo en el host de despliegue (§2)
- `caddy validate` del Caddyfile (mismo motivo)
- `pnpm --filter @pos/web build` (prohibido por la regla NEVER BUILD): el
  PWA config nuevo (`navigateFallbackDenylist`, `runtimeCaching`) se revisó
  por tipos y por lectura, **no** por un `sw.js` generado
- arranque real de Postgres + API contra una base **vacía**: el E2E sí
  corrió `initBaseline()` contra Postgres, pero contra una base que ya
  tenía el schema (drizzle push); el caso "base recién creada, sin nada"
  sólo está cubierto por el test sobre PGlite
- `owner-provision` contra una base real (el modo `--dry-run` y el muteo
  del input sí se probaron sin tocar la base)
- comportamiento real de TLS/ACME de Caddy, healthchecks en marcha,
  rotación de logs y cron de backups
