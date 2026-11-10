# NEXORA — sync durable de ventas grandes

## Contrato y decisiones (project: nexora)

Objetivo: una venta de más de 50 mutaciones viaja en partes, pero ticket,
líneas, pago, diario y refreshes de variantes tienen **un único commit de
negocio**. Se garantiza efecto idempotente, no transporte exactamente-una-vez.
El endpoint legacy `POST /api/sync/mutations` mantiene su límite de **50**.
No se cambió UI ni se ejecutó build.

Elegimos staging PostgreSQL durable + snapshot PGlite durable. Subir el límite
HTTP no permite recuperar uploads parciales; aplicar cada bloque como venta
dejaría stock/pagos parciales. El costo de staging es almacenamiento temporal,
un roundtrip por parte y un recibo permanente por operación aplicada.

### Wire protocol

1. Antes del primer fetch, guardar `sync_sale_outbox.rows` (snapshot inmutable
   de las versiones de `sync_log`) con `operation_id` UUID aleatorio y tenant
   local. No reconstruir ese snapshot desde una cola que ya cambió.
2. Parsear envelopes con el schema compartido. Manifest estricto:
   `{ ticket_id, count, parts: [sha256Parte…], hash: sha256TodosLosEnvelopes }`.
   SHA-256 sobre `canonicalJson`, incluyendo UUID, entidad, op y `client_ts`.
   Arrays conservan orden, claves de objetos se ordenan recursivamente.
3. `POST /api/sync/sales/:operation/parts` recibe
   `{ manifest, index, mutations }`. Crea/repite una parte indexada; manifest
   y contenido de una parte son inmutables. Reordenar uploads es válido.
   **Ninguna escritura de negocio** sucede aquí.
4. `POST /api/sync/sales/:operation/finalize` recibe el manifest completo.
   Valida todas las partes/índices/hashes, count, UUIDs únicos, un único ticket,
   padres, cantidades/subtotales/total/pagos y deltas de venta por variante.
   Rechaza entidades de catálogo arbitrarias, shifts y arqueos en el agregado.
   Los únicos extras admitidos son refreshes de las variantes vendidas y
   movimientos iniciales pendientes de esas variantes nuevas. Un movimiento
   inicial sobre variante ya existente exige ledger idéntico (replay).
5. Dentro de la misma transacción: serialización por tenant/operación y por
   ticket, comprobación de pertenencia de IDs/dependencias, bloqueo del ticket
   y del turno, turno abierto sin arqueo, aplicación del grupo, recomputación
   de stock desde diario, persistencia del recibo y eliminación de partes.
   Cualquier resultado rejected aborta **todo** el finalize, incluso si antes
   hubo miembros válidos. La aplicación comparte los guards legacy de void,
   pago confirmado, LWW y preservación de código/costo omitidos.
6. Respuesta `{ results }` solo después del commit. Repetir finalize devuelve
   el recibo sin reaplicar. Recibo de ticket posteriormente anulado incorpora
   `voided_ticket` para recuperar el mirror canónico.
7. Solo tras validar el ACK de TODOS los UUIDs: transacción PGlite marca
   `synced` las filas cuyo `client_ts` **y** payload siguen siendo los enviados
   y elimina el snapshot. Una edición posterior queda pendiente. Un corte
   antes/después del commit local vuelve a usar la misma operación.

Todo endpoint exige sesión y membresía actual. El tenant se obtiene de sesión,
nunca del manifest. PK/FK de staging son compuestas por tenant + operación.
Finalize ajeno/inexistente/dependencias ajenas → **404 genérico**; sin sesión
→ 401; membresía revocada → 403. Upload es create-or-replay en el namespace de
la sesión: usar el mismo UUID desde otro tenant crea otra operación y no revela
la existencia de la primera. No habilita anulación: `sale_void`/status voided
siguen reservados al comando owner del servidor.

### Límites y errores

| Recurso | Límite |
|---|---:|
| Batch legacy / parte | 50 mutaciones |
| Operación | 2000 mutaciones, 40 partes |
| Snapshot que emite el cliente | 2 MiB de JSON canónico UTF-8 |
| Request de upload / parte canónica | 1 MiB |
| Payloads de operación en servidor | 4 MiB de texto jsonb agregado |
| Operaciones sin recibo por tenant | 32 |
| TTL de uploads sin commit | 7 días desde su creación |
| Recibos aplicados | Sin TTL |

Count/shape/hash/aggregate inválido → 400; parte/payload excesivo → 413;
manifest o parte reemplazada, incompleto, turno cerrado, rechazo de negocio
→ 409; cuota → 429. Códigos operativos: `sale_part_hash`,
`sale_manifest_hash`, `sale_manifest_conflict`, `sale_incomplete`,
`sale_invalid_*`, `sale_mixed_entities`, `sale_rejected:<reason>`,
`sale_staging_quota`, `shift_closed`.
La cola conserva `last_error`, disponible en el detalle de sincronización.
Los límites locales incluyen mensaje en español. Rechazos deterministas siguen
el contrato failed → poison a los 3 intentos; red, 404/dependencias, 429,
db_error y respuestas incompletas siguen reintentables.

El tamaño efectivo también depende del límite por parte; no se promete que
todo payload de 2 MiB se distribuya dentro de partes de 1 MiB si las primeras
50 filas concentran todo el contenido. El rechazo es explícito, sin commit.

### Reintentos, dependencias y limpieza

- Una parte aceptada con respuesta perdida puede reenviarse idéntica. Si se
  pierde respuesta de finalize, el mismo operation recupera el recibo.
- El ledger por UUID y las transacciones impiden duplicar deltas incluso
  reenviando el mismo snapshot bajo otra operación mientras el turno sigue
  abierto. Un recibo ya aplicado puede recuperarse después del cierre.
- Orden topológico de cola: categoría/producto/turno antes de consumidores;
  la venta que lleva la creación de una variante precede otras ventas que
  la referencian. Los movimientos iniciales pendientes se agrupan con ella.
  Dentro del grupo se aplica ticket y variantes antes de sus dependientes.
- No se mezcla catálogo arbitrario dentro del snapshot de venta. Productos
  y categorías son prerequisitos separados; la primera variante y su diario
  inicial pueden crearse atómicamente con la venta que los necesita.
- Un snapshot durable se intenta por drain, rotando `last_attempt`, y luego
  progresa trabajo independiente. Se excluyen sus UUIDs de nuevos snapshots
  mientras no se resuelva. Así muchos uploads fallidos no monopolizan los
  10 rounds del drain. Se difieren cierres mientras existan ventas pendientes
  o poison/snapshots; no se alteran arqueos cerrados.
- En upload se limpian operaciones **del tenant** sin recibo con más de 7
  días; sus partes desaparecen por FK. El cliente conserva snapshot y resube
  todas las partes, por lo que puede reconstruir un upload expirado.
- Rechazos terminales de finalize liberan su staging/cuota únicamente si
  coincide el manifest y aún no hay recibo. Incompletos/db_error no se borran.
  Los recibos confirmados nunca se borran ni se reaplican por el cleanup.
- El recibo permanente ocupa espacio (incluye resultados por mutación).
  Compactarlo requeriría mantener un tombstone durable equivalente; borrarlo
  por TTL sería una modificación del contrato de idempotencia.

## Migración y despliegue

`SALE_STAGE_MIGRATION_SQL` crea tablas/índice con `IF NOT EXISTS`, en el boot
API después de auth/catalog. El schema Drizzle también declara las tablas
server-only. `SALE_OUTBOX_MIGRATION_SQL` crea outbox y agrega `last_attempt`
in-place en PGlite. **Se conserva `pos_v3`**, sus datos y pendientes.
No requiere `drizzle-kit push` sobre bases existentes. Primero desplegar API
con endpoints/migración y luego web. El cliente nuevo contra API vieja conserva
el snapshot/pendientes ante 404 y reintenta cuando esté disponible.

La infraestructura existente de tests recrea únicamente `pos_piloto_test` y
`pos_piloto_e2e`; sus pushes de schema son sobre bases desechables recién
creadas. No se ejecutó push de schema ni DROP contra la DB dev; no se detuvieron
procesos del usuario. E2E usa 3101/5181 y `reuseExistingServer: false`.

## Evidencia y progreso

- Baseline confirmado: árbol limpio, `main == origin/main`, último `b8016af`
  (SKU), previo `5344939` (anulaciones). No hay AGENTS anidados ni registro
  `.atl/skill-registry.md`. Skills: explore/apply; sin Task/Engram disponibles.
- Shared: `pnpm --filter @pos/shared test` → **25/25**.
- API: `pnpm --filter @pos/api test` → **139/139** inicialmente. Después de
  agregar tres escenarios y ajustar validaciones/migración, ejecución dirigida
  `pnpm --filter @pos/api exec vitest run test/sale-stage.test.ts test/schema-contract.test.ts test/sync-idempotency.test.ts`
  → **36/36**, incluidos **17/17** escenarios staging. Inventario actual:
  **142 tests API**; no se repitió toda la suite innecesariamente.
- Web: suite inicial **53/54**, falló una expectativa del test (una edición
  posterior se envía en el drain siguiente, no dos veces por UUID en el mismo
  drain). Se corrigió y pasó la repetición dirigida **1/1**. Tras agregar
  rotación/no starvation, orden y migración: ejecución sale-upload + void-sale
  **8/9**, con única falla Date vs JSON string en el nuevo test de migración.
  Corregida comparación de roundtrip, repetición dirigida **1/1** verde.
  Inventario actual: **57 tests web**, todos cubiertos con resultado verde.
- Browser: suite inicial **7/9**; fixture nuevo tenía cast text→uuid faltante
  y luego faltaba abrir tab Venta. Se corrigieron. Anulaciones reveló una
  carrera del test: badge cero anterior al comienzo de la sync de venta;
  ahora espera recibo PGlite real del pago antes de abrir detalle (**1/1**).
  El nuevo test también espera estado local durable, no badge de boot.
- Último E2E dirigido, tras cambios finales de producción:
  `E2E_API_PORT=3101 E2E_WEB_PORT=5181 pnpm e2e e2e/large-sale.spec.ts`
  → **1/1**. Los **9 escenarios browser** tienen ejecución verde en esta
  sesión, mediante suite inicial y repeticiones de fallos/código afectado.
  No se afirma un único run final completo verde.
- Checks finales: `pnpm typecheck` (shared/API/web) y `pnpm lint` verdes;
  `git diff --check` limpio. Total de escenarios unit/integración actuales
  cubiertos en la sesión: **224** (25 shared + 142 API + 57 web), más **9**
  browser. Se ejecutaron suites secuencialmente; luego solo fallos/áreas
  afectadas por cambios. Sin build.
- E2E grande: carrito real de **18 variantes / 56 mutaciones**, offline,
  reload, corte después de persistir primera parte, reload con outbox durable,
  pérdida de respuesta DESPUÉS de finalize server y reintento automático.
  Se observa un solo operation UUID, **1 ticket / 18 líneas / 1 pago /
  18 movimientos sale**; saldo inicial 180 → **162** en diario, variantes y
  stockcurrent; pago exacto **1800 COP**; 18 códigos y costos intactos.
- API cubre uploads parciales/out-of-order/repetidos sin negocio, finalize
  concurrente, replay, hashes/count/totales/deltas/entidades inválidos, permisos,
  referencias tenant, void guard, TTL/cuota, primera variante offline,
  conflicto tardío con rollback total y carrera contra cierre.
- Web cubre cortes en cada parte, pérdida de ACK finalize, old ACK vs edición
  con código/costo nuevo, snapshot durable, errores aislados, no starvation,
  cierre diferido, orden de dependencias y migración aditiva repetida.

## Cierre de sesión / memoria filesystem

**Goal:** completar staging atomic/idempotente para ventas >50, tests y entrega
autorizada a origin main.

**Instructions:** apply_patch; no build, no git config/attribution; suites
secuenciales y repetir solo fallos/código afectado; conservar user edits/DB dev.

**Discoveries:** upsert-latest puede mover una variante nueva a una venta
posterior: agrupar sin dependencias no alcanza. Una cuota de snapshots fallidos
puede consumir todos los rounds si no se reserva progreso independiente. Un
badge de boot/catálogo en cero no prueba que el pago nuevo tenga ACK local.

**Accomplished:** protocolo/contratos, migraciones aditivas, snapshot durable,
finalize transaccional y recibo, guards/tenant/cuotas/TTL y pruebas descritas.
Engram no disponible; este documento conserva decisiones, evidencia y límites.

**Next Steps:** priorizar preservación de pendientes en logout/upgrade.
`App.tsx` aún documenta que logout offline borra pendientes y ofrece
«Continuar sin sincronizar» al cambiar datadir; hace falta un flujo de
conservación/exportación/restauración que contemple también outbox. Luego,
costos históricos: `DASHBOARD_SUMMARY_SQL` sigue calculando COGS con el costo
actual de variante, no un snapshot de costo por línea. Staging preserva costo
actual, no resuelve esa exactitud histórica. Auditar también referencias
tenant en el camino legacy con el mismo rigor del finalize nuevo.

**Relevant Files:**
- `packages/shared/src/sale-sync.ts` — schemas, SHA-256, límites y DDL aditiva.
- `apps/api/src/db/{sale-stage,sync-apply,schema}.ts` — staging/atomicidad/locks.
- `apps/api/src/sync/route.ts`, `src/server.ts` — endpoints y boot migration.
- `apps/web/src/sync/{sale-upload,queue,batch}.ts` — snapshot/ACK/dependencias.
- `apps/web/src/db/pglite.ts` — mismo datadir con migración aditiva.
- `apps/api/test/sale-stage.test.ts`, `apps/web/test/sale-upload.test.ts`,
  `e2e/large-sale.spec.ts` — evidencia de integración y resiliencia.
- `e2e/void-sale.spec.ts` — espera recibo real antes del detalle.
