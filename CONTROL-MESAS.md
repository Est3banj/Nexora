# NEXORA — control de mesas: factibilidad, opciones y hoja de ruta

> **Análisis NO-implementativo** · HEAD `1826325` (árbol limpio) · sin cambios de código.
> Todo lo que sigue está citado con `archivo:línea` del estado actual. Donde no hay dato,
> se dice «no verificado» en lugar de suponer.

---

## Veredicto (30 segundos)

- **Sí es posible integrar control de mesas**, y el patrón de sync **sí permite** mantener una
  mesa/orden abierta sincronizada (upsert-latest + LWW + grupos por padre + rehydrate).
- **El cuello de botella NO es el schema: es la lectura.** El sync es **push-only** — no existe
  pull en vivo entre dispositivos (`App.tsx:194-211`, `App.tsx:321-332`). Una mesa abierta en la
  tablet del salón **no aparece** en la caja hasta que esa caja rehidrate (boot vacío o upgrade de
  datadir). Eso vale para C y para A por igual.
- **La opción A («ticket abierto») NO es la vía rápida que parece**: `ticket_lines` es evidencia de
  dinero (void, COGS, top-products, validación de totales) y el protocolo de sync **no tiene
  operación de borrado** ni admite `qty = 0` (`mutations.ts:70`). Quitar papas de una mesa abierta
  es, hoy, innecesariamente caro en A.
- **Recomendación:** MVP = **C con el schema definitivo de B** (órdenes locales, ticket recién al
  cobro) → **Fase 2 = B** (entidades `order`/`order_line` sincronizadas + pull). **A queda
  descartado** salvo que el usuario priorice «reutilizar tickets» sobre «modelo limpio».
- **Gate decisivo para mañana:** ¿hay **multi-dispositivo desde el día 1**? Si la respuesta es sí,
  el MVP arranca ya con sync (B temprano) y con un endpoint de lectura; si es no, C basta y es
  barato.

---

## Encargo

- **Público:** dueños y cajeros de restaurantes/cafés colombianos; el cajero cobra en el mostrador
  o en la mesa, el dueño revisa corte y reportes.
- **Objetivo:** dejar una mesa ocupada con su orden en curso, retomarla y cobrar al final, sin
  perder la orden por un reload ni mezclarla con la venta de mostrador.
- **Oferta:** flujo mesa → orden → cobro **sin romper nada de lo que ya funciona**: arqueo, corte,
  fiado, anulaciones, cola offline.
- **Vistas nuevas:** tablero de mesas (libre/ocupada, total, tiempo) + «orden en curso» reutilizando
  la pantalla Sale existente.
- **CTA por vista:** tablero → «Abrir/Retomar mesa»; orden → «Procesar Cobro» (ya existe).
- **Restricciones:** React19 + Vite, CSS propio, PGlite, Fastify + Drizzle, cola durable, roles
  actuales, **sin IVA** (B1), dinero entero COP.

---

## FASE 1 — Hechos del codebase

### 1. Ciclo de vida del carrito/venta HOY

- **El carrito es memoria efímera.** `const [lines, setLines] = useState<CartLine[]>([])`
  (`apps/web/src/hooks/useSale.ts:35`). No hay escritura a PGlite ni a `localStorage` para el
  carrito: las claves locales existentes son `pos:reauth`, `pos:tenant-name:*`, `pos:settings:*`,
  `pos:datadir-version`, `pos:last-sync:*` y `pos:member-role` (sessionStorage) — ninguna guarda
  líneas.
- **Sobrevive:** Escape en el cobro, cierre del modal, navegación entre pestañas (el componente Sale
  se desmonta al cambiar de tab… ver caveat abajo), errores de commit. **No sobrevive:** reload,
  crash, cierre de pestaña, cambio de pestaña si Sale se desmonta.
- **Escape en el cobro:** `onCancel` cierra solo si no hay commit en vuelo — *«draft/cart
  survive»* (`PaymentModal.tsx:363-367`); el comentario de lifecycle dice explícitamente que el
  carrito lo retiene el padre y solo se resetea el borrador de pago (`PaymentModal.tsx:203-204`,
  reset en `205-218`). El importe recibido/método se limpian al reabrir (`Sale.tsx:395-397`) y
  `setLines([])` solo corre **después** de un commit exitoso (`useSale.ts:91`).
- **Commit:** UNA transacción local `ticket + ticket_lines + payments + stockdiary + stock +
  sync_log` (`local.ts:839-1053`, comentario `827-831`: *«partial write impossible»*). Si el commit
  lanza (`EMPTY_CART`, `NEGATIVE_STOCK`, cupo…), el carrito queda intacto (`Sale.tsx:485-486`).
- **Ventas grandes** se snapshotan en `sync_sale_outbox` y sobreviven a crash
  (`queue.ts:165-172`, `PRESERVACION-LOCAL.md`).

### 2. Esquema y estados de tickets/payments

- `tickets`: `id, tenant_id, client_uuid, shift_id, ticket_no, status, total, customer_id,
  created_at, updated_at` (`schema.ts:171-192`). **No hay `note`, ni `meta`, ni `table_id`.**
- `tickets.status`: default `'completed'` (`local-schema.ts:176`, `schema.ts:179`). Valores reales
  en uso:
  - `'completed'` — venta de efectivo/crédito (`local.ts:892`),
  - `'transfer_pending'` — transferencia esperando confirmación de dueño (`local.ts:892`,
    enum en `mutations.ts:56`),
  - `'voided'` — solo vía comando de anulación online (`void-sale.ts` server `:65`),
    **no existe en el enum de sync**.
- **No existe estado «abierto».** El ticket se crea recién en el cobro.
- `payments.status`: `'pending' | 'confirmed'` (`mutations.ts:86`, `schema.ts:293`); `credit` nace
  siempre `confirmed` (`sync-apply.ts:554`). Hay precedente de **flip de estado** en dos direcciones
  acotadas: `pending→confirmed` + `transfer_pending→completed` en la misma tx, estricto, owner-only
  (`scope.ts:915-955`, `local.ts:1064-1146`), con guardia de reversa
  (`sync-apply.ts:553`: *confirmed no vuelve a pending*).
- `ticket_no`: `MAX(ticket_no)+1` por tenant dentro de la tx (`local.ts:879-883`), único
  (`local-schema.ts:182`); la colisión offline multi-dispositivo está **documentada como no
  resuelta** (`FIADO.md:41`).

### 3. Mecánica de sync

- **12 entidades** en `MUTATION_ENTITIES` (`mutations.ts:20-35`): ticket, ticket_line, payment,
  stockdiary, category, product, variant, closedcash, shift, customer, credit_abono, cash_movement.
  `op` es literal `'upsert'` — **no hay operación de delete** (`mutations.ts:218`).
- **Push-only.** Drenaje local → `POST /api/sync/mutations` (`queue.ts:240`); el único pull de
  negocio es `GET /api/rehydrate`, ejecutado **solo** cuando la cache está vacía
  (`App.tsx:194-211`, condición `isLocalCacheEmpty` en `local.ts:1633-1642`) o tras upgrade de
  datadir (`App.tsx:321-332`). Existe además `GET /api/sales/tickets` y `/:id`
  (`sales.ts:58-78`), hoy usados solo por el camino de anulación (`void-sale.ts:45` web).
- **Conflictos:** LWW por `client_ts` + hash de contenido; entrada más vieja o igual con contenido
  distinto → `rejected: conflict_hash_mismatch` + `audit_log` (`sync-apply.ts:21-29`, apply en
  `:384-418`). **Nunca una segunda fila.**
- **Upsert-latest por `(tenant_id, client_uuid)`** en la cola (`local.ts:92-102`): una fila de
  negocio = una fila de cola; cada edición reescribe payload + `client_ts`. Ediciones concurrentes
  de dos dispositivos sobre la misma fila → **gana la última, sin merge ni aviso**.
- **Grupos:** `groupQueue` agrupa ticket+líneas+payment+stockdiary+variant por `ticket_id`
  (`batch.ts:5-54`); el server aplica **un tx por grupo** con advisory locks (`sync-apply.ts:65-81`,
  `:164-168`). Un grupo de **>50 filas** se rutea al **snapshot de venta**
  (`queue.ts:192-199`), cuya validación exige **≥1 payment**, totales cuadrados y `shift_id`
  (`sale-stage.ts:43-53`, `:116`) — una orden abierta sin cobro **fallaría** ahí
  (`sale_invalid_aggregate` → determinista → `poison` a los 3 intentos).
- **Congelamiento de turno cerrado:** tocar `ticket/payment/ticket_line` de un ticket cuyo
  `shift_id` ya tiene `closedcash` → `InvalidSync` (`sync-apply.ts:462-475`). Mismo principio en
  void (`void-sale.ts` server `:17-19`).
- **Autoridad de member:** pre-scan por ítem en la ruta (nunca HTTP 403) — member no puede
  category/product ni variant/stockdiary sin `ref_ticket_id` (`route.ts:69-86`), y
  `validateMemberHints/validateMemberMovements` exigen evidencia de venta persistida
  (`sync-apply.ts:289-321`).
- **Precedente de entidad «en curso» sincronizada:** el par
  `ticket transfer_pending` + `payment pending` (ver §2). Es el único estado de negocio no terminal
  que ya viaja por sync. Las operaciones en staging (`sync_sale_*`) son transporte, no estado.

### 4. Contabilidad de corte/arqueo — qué cuenta «ventas»

- **`expected` sale SIEMPRE de `payments`**, nunca de carritos ni de tickets
  (`arqueo.ts:25-39`, comentario `:6-10`); excluye tickets `voided` y separa transfers `pending`
  (`arqueo.ts:28`, `:51`).
- **Ingresos/reportes/dashboard** = `payments` con `status='confirmed'`
  (`reports.ts:29-63`, `:246-284`). Un ticket **sin pagos aporta 0** — ahí el «solo completed
  suma» ya está garantizado por construcción.
- **Pero hay dos fugas si aparece un estado nuevo:**
  - `TOP_PRODUCTS_SQL` filtra solo `tk.status <> 'voided'` (`reports.ts:94`) → un ticket abierto
    **contaría** en top productos sin generar ingreso.
  - `DASHBOARD_SUMMARY_SQL` COGS filtra `tk.status IN ('completed','transfer_pending')`
    (`reports.ts:262`, `:272`) → un ticket `open` queda fuera (correcto), pero **cambia de
    criterio** respecto a top-products: hoy ya hay dos semánticas distintas.
  - Además COGS bucketea por `tk.created_at` y revenue por `p.created_at` → una orden abierta un
    día y cobrada al siguiente **descuadra margen por día** (ingreso D+1, costo D).
- **Listado de Tickets** no filtra status (`local.ts:1192-1210`) y el badge diría **«Pagada»** para
  un ticket sin pagos (`Tickets.tsx:78-83`: si no es voided ni `pay_status==='pending'` → `b-paid`).
- **Cierre de caja:** `closeLocalShift` **no** mira mesas ni estados abiertos — solo exige turno
  abierto (`local.ts:1433-1473`). El único guardia previo es *evidencia del turno sin sincronizar*
  (`hasPendingShiftEvidence`, `local.ts:1416-1425`, usado en `Arqueo.tsx:222`). Precedente útil:
  **excluir y reportar** (transfers pendientes) en vez de bloquear.
- **Venta sin turno abierto está permitida**: `shift_id = null` (`local.ts:885-889`) y hay test que
  la fija (`apps/web/test/local-sale.test.ts:189`). Eso abre la puerta a «orden abierta sin turno»,
  con la contrapartida de que un pago con `shift_id` null **no entra a ningún arqueo**.

### 5. Superficies UI implicadas

- **Sale:** dos paneles en desktop ≥1024 (`Sale.tsx:777-920`, grilla + «Orden Actual») y grilla +
  barra inferior en móvil (`Sale.tsx:922-976`); tiles con badge de stock (`LOW_STOCK_BADGE = 5`,
  `Sale.tsx:54`, `.sale-grid` en `app.css:498` con breakpoints en `responsive.css:104,233,256`).
- **Tickets:** filtros status/método separados, badges (`Tickets.tsx:59-83`), tabla con región de
  scroll (`:433-508`).
- **Patrón de tablero más cercano:** cards de Clientes & Fiados con badge de estado derivado
  (`Credito.tsx:178-182`, grid `:306-319`, `.client-grid` `app.css:3446`) — misma gramática que
  usaría el tablero de mesas: tile + badge (Libre/Ocupada) + total + minutos.
- **Navegación:** matriz única `NAVIGATION` con `tier: "all" | "dueno"` (`navigation.ts:11-20`) y
  `visibleNav()` fail-closed (`:51-62`); wiring de tabs en `App.tsx:606-663`. Una pestaña «Mesas»
  entraría con `tier: "all"` (el cajero la necesita).
- **No existe ningún concepto «mesa»/`table` en el código** (grep en `apps/` y `packages/` sin
  resultados relevantes).

### 6. Migraciones — qué implica agregar tablas BOTH

- **Local:** `LOCAL_SCHEMA_SQL` se ejecuta en **cada open** de PGlite (`pglite.ts:113`); las
  aditivas son strings idempotentes embebidos (`VARIANT_CODE_*`, `FIADO_*`, `PROTOTYPE_*`,
  `TICKET_LINE_COST_*` en `local-schema.ts:11-105`). DDL aditiva idempotente = **sin bump de
  `DATA_DIR_VERSION`** (comentario `local-schema.ts:44-46`); solo los cambios destructivos bump'an
  (`pglite.ts:17`, `instance.ts:83-98`).
- **Server:** `initBaseline()` marker-gated una vez (`init-baseline.ts:84-127`, marker
  `business-schema-v1`) y luego la cadena de aditivas en cada boot (`server.ts:13-22`); el patrón
  de una tabla nueva es `CREATE TABLE IF NOT EXISTS` compartido + un `migrate-mesas.ts` de 7 líneas
  (forma exacta de `migrate-fiado.ts:5-7`).
- **Contrato de paridad:** `schema-contract.test.ts` compara columnas entre `local-schema.ts` y el
  Drizzle (`SHARED_TABLES` en `:18`, `EXPECTED_INDEXES` en `:35`) — cambiar uno sin el otro rompe el
  gate.
- **Aislamiento:** `BUSINESS_TABLES` (15 tablas) alimenta logout/upgrade/tenant-switch
  (`preservation.ts:12`) — **una tabla nueva ausente = fuga entre tenants** en dispositivo
  compartido; `isolation.test.ts` (20 assertions) lo barre server-side.
- **Rehydrate:** forma de página + inserción (`rehydrate.ts:21-37`, `:57-316`) y endpoint
  (`routes/rehydrate.ts:28-62`) — tabla nueva sin rehydrate = no aparece en dispositivo fresco.

### 7. Roles/permisos — dónde encajaría «abrir/servir/cobrar mesa»

- Matriz vigente (`ROLES-ADMIN.md:110-118`): `member` (Cajero) ve 5 pestañas y **vende, cobra y
  registra abonos**; `owner/admin` ven 8. El servidor es la autoridad (403 aunque el hint diga lo
  contrario).
- **Abrir/servir/cobrar mesa = misma clase de acción que vender** → `tier: "all"`, cualquier rol
  verificado, sin gates nuevos en Fase 1.
- **Cancelar mesa** (sin dinero) → proponer la misma regla que anular: Dueño tier, o `member` con
  `require_annul_code` ON (`Sale.tsx:121`, `Tickets.tsx:129`); ojo: **la anulación es online-only**
  (`void-sale.ts` web `:52`, `ANULACIONES.md`) y hoy exige payments + turno abierto — no sirve para
  un ticket sin cobro (ver §2 y §FASE2-A).
- **Confirmar transferencia** sigue siendo owner-only (`payments.ts:21-36`, `Tickets.tsx:130`).
- Toggles de operación existentes (`enable_fiado`, `allow_negative_stock`, `require_annul_code`) son
  el patrón para un eventual `enable_mesas`: server-authoritative + cache hint en `localStorage`
  (`lib/settings.ts:4-6`), fila ausente = comportamiento actual.

---

## FASE 2 — Opciones

### A) «Ticket abierto» — el ticket nace al sentar la mesa

**Cómo funciona.** Se amplía `tickets.status` con `'open'`; al sentar se crea el ticket
(`shift_id` null para esquivar el congelamiento de turno cerrado, `sync-apply.ts:470`) con sus
líneas; cada edición es un upsert LWW del mismo `client_uuid`; al cobro se agregan `payments`, se
flipa a `'completed'` y el resto del flujo (arqueo, reportes, recibo) funciona igual.

**Schema大概.** `tickets.status ∈ {open, completed, transfer_pending, voided}` + columna nueva
`tickets.table_no` (o `table_id`). Nada más: sin tablas nuevas.

**Qué toca.** `mutations.ts` (enum status + guardias), `sync-apply.ts` (guard de transición
`completed→open` prohibido — hoy **no lo hay** para tickets; solo existe para payments en `:553`),
`sale-stage.ts:49` (snapshot exige payment), `void-sale.ts` server (exige payments y turno abierto
→ hace falta «cancelar orden» aparte), `reports.ts:94` (top-products), badge/lista
(`Tickets.tsx:78-83`, `local.ts:1192`), y **el ciclo de vida de líneas** (abajo).

**Pros.** Cero tablas nuevas; reutiliza cola, grupos, rehydrate, receipts, lista de tickets,
`ticket_no` temprano; los reportes de dinero ya son payments-driven (no hay que tocar arqueo).

**Contras (los reales).**
1. **Borrar/quitar líneas no tiene primitiva.** `op` solo acepta `upsert` (`mutations.ts:218`) y
   `qty` es `> 0` (`:70`). Quitar una línea exige **soft-delete en `ticket_lines`** (columna nueva
   en ambos schemas + filtros en `TICKET_ITEMS_COLUMN` (`local.ts:1181-1190`),
   `TOP_PRODUCTS_SQL`, `getLocalTicket`, sumas de `void-sale.ts:44-48`, `sale-stage.ts:51-53`,
   COGS del dashboard) — **6+ sitios que son evidencia de dinero**.
2. **Anulación no sirve para órdenes sin cobro** (`incomplete_sale` si no hay payments,
   `void-sale.ts:44-49`) → comando nuevo «cancelar orden».
3. **Congelamiento por turno cerrado** (`sync-apply.ts:462-475`) + void exige turno abierto.
4. **Grupo >50 filas cae al snapshot** y falla sin payment (`queue.ts:192`,
   `sale-stage.ts:49`) — una orden con ~16 líneas (3 filas de cola por línea: line + stockdiary +
   variant) ya lo supera.
5. **Sin guard de transición de status** en tickets: un cliente buggeado podría LWW-flipar
   `completed → open` (los payments sí lo protegen, `sync-apply.ts:553`).
6. **Fugas de reporte** (top-products) y **desfasaje de margen** por `created_at` vs
   `payment.created_at`.

**Esfuerzo relativo:** **medio-alto** (mayor blast radius sobre tablas ya certificadas).

---

### B) Entidad dedicada `tables` + `orders`/`order_lines`

**Cómo funciona.** Mesas y órdenes son dominio propio con sync propio; el ticket se genera **al
cobro** reutilizando `commitLocalSale` tal cual (`local.ts:839`), con las líneas de la orden como
`SaleLineInput[]`. El dinero no se toca hasta que hay cobro.

**Schema大概.**
- `tables (id, tenant_id, client_uuid, name/number, active, …)` — catálogo, sync tipo `solo`
  (mismo patrón que `category`).
- `orders (id, tenant_id, client_uuid, table_id, status open|serving|closed, opened_at, note, …)`.
- `order_lines (id, tenant_id, client_uuid, order_id, variant_id, qty, unit_price, state
  sent|pending, deleted_at, …)` — con **borrado/suavizado resuelto desde el diseño** (o `op:
  delete` propio), sin tocar `ticket_lines`.

**Qué toca.** `mutations.ts` (+2-3 entidades y schemas zod), `sync-apply.ts` (`applyOne` cases +
`groupKeyOf` por `order_id`), `batch.ts` (dependencias `table_id`/`order_id`), `schema.ts`
(Drizzle), `local-schema.ts` (DDL), `BUSINESS_TABLES`, rehydrate (web + api), `migrate-mesas.ts` +
`server.ts`, tests de paridad/isolation/member-authority, más el endpoint de lectura (pull).

**Pros.** Modelo limpio: **ciclo de vida de líneas libre** (agregar/quitar/mover sin tocar
evidencia de dinero), cancelar = estado del orden (no `void`), split/mover mesa y comandas son
evoluciones naturales, `ticket_lines`/void/arqueo/reportes **no se tocan**, y C→B es
**aditivo sin migración de datos** si el MVP ya usa este schema local.

**Contras.** Es el mayor *plumbing* (2-3 entidades × 2 stores + paridad + rehydrate + autoridad de
member); hay que regla la conversión orden→ticket (totales, stock, `ticket_no`); dos fuentes de
verdad de «qué hay en la mesa» hasta el cobro; más tests.

**Esfuerzo relativo:** **alto en Fase  2, bajo en Fase 1** (el schema local es igual que C).

---

### C) Mesa-ociosa local — órdenes abiertas solo en el dispositivo

**Cómo funciona.** Tablas locales `orders`/`order_lines` **sin** entrar a `MUTATION_ENTITIES`:
sobreviven reload/crash (hoy el carrito no), el tablero funciona offline-first por construction, y
al cobro se llama `commitLocalSale` (ticket + pago + stock + cola, tal cual hoy).

**Schema大概.** Igual que B pero solo en `LOCAL_SCHEMA_SQL` + `BUSINESS_TABLES`. **Cero cambios de
server, cero deploy de API.**

**Pros.** El más rápido; sin riesgo de sync; sin fugas de reportes (no hay ticket hasta el cobro);
borrado de líneas trivial; el flujo completo mesa→orden→ cobro queda en 1 dispositivo.

**Contras.** **Sin cross-device en absoluto** (ni siquiera tras rehydrate: no hay nada que
rehydratar); dispositivo perdido = mesas perdidas; «cobrar en la caja desde otra tablet» imposible;
si más adelante se quiere multi-dispositivo, se agrega sync (barato si ya es B) o hay que migrar a
A (caro).

**Esfuerzo relativo:** **bajo**.

---

### Análisis honesto de sync multi-dispositivo (A y C)

| Pregunta | C (local) | A (ticket abierto sincronizado) |
|---|---|---|
| ¿Sobrevive reload/crash? | **Sí** (PGlite) | Sí (PGlite + server) |
| ¿Se ve en OTRO dispositivo en vivo? | **No** | **No** — el sync es push-only; el otro dispositivo no pulla (`App.tsx:194-211`) |
| ¿Aparece en un dispositivo nuevo? | **No** | Sí, al rehidratar |
| ¿Dos dispositivos editan la misma mesa? | No se enteran (doble orden silenciosa) | LWW por fila: **gana el último, sin merge, sin aviso** (`sync-apply.ts:384`) |
| ¿Cobro en caja de una mesa abierta en tablet? | **Imposible** | **Imposible en vivo**; hoy solo vía pull nuevo (`GET` existe como precedente en `sales.ts:58`) |
| Riesgo de `poison` | Cero | Grupo >50 sin payment → `sale_invalid_aggregate` (`sale-stage.ts:49`) |
| Riesgo de corte | Cero (no hay fila hasta cobrar) | Cero si no hay payments; **fuga en top-products** (`reports.ts:94`) |

**Conclusión:** el patrón de sync **permite** la opción A, pero **ninguna de las dos da
multi-dispositivo real sin un pull nuevo**. Ese pull (lectura de mesas/órdenes abiertas + refresh
al foco/intervalo) es la feature que de verdad habilita «mesa en la tablet, cobro en la caja», y su
costo es **el mismo** para A, B o C+sync.

---

## FASE 3 — Recomendación por fases

### Gate primero (mañana, antes de codificar)

Contestá las **preguntas abiertas** de abajo. La que decide la ruta es **#1 (multi-dispositivo
día 1)**.

### Fase 1 — MVP: board + orden + cobro en 1 dispositivo (semáforo verde con C/B-local)

1. Schema local: `tables` (numeración simple 1..N, alta en Admin o auto-provision), `orders`,
   `order_lines` — **ya con `deleted_at` y `state`** para no rehacer nada en Fase 2.
2. Pestaña **«Mesas»** (`tier: "all"`) + board (grid de tiles con badge Libre/Ocupada, total,
   minutos, tipo `client-grid`/`sale-grid`).
3. Flujo: tile → «Abrir mesa» → **cargar la orden en el carrito existente** (o pantalla de orden
   con la misma grilla de Sale) → «Retomar» → **cobro con `PaymentModal` actual** →
   `commitLocalSale` → mesa libre. El flujo **mostrador sin mesa sigue intacto en paralelo**.
4. **No se toca:** sync, server, reportes, void, arqueo, `ticket_lines`.
5. **Límite documentado en el doc y en la UI:** «Las órdenes abiertas viven en este dispositivo».

*Costo estimado:* el más bajo de los tres caminos; sin deploy de API.

### Fase 2 — Sync de órdenes (= B) + lectura cross-device

1. `order` / `order_line` / `table` como entidades nuevas (mutaciones, zod, `applyOne`,
   `groupKeyOf`, Drizzle + DDL, `BUSINESS_TABLES`, rehydrate, `migrate-mesas.ts`, paridad).
2. **Pull:** `GET /api/orders/open` (o filtro sobre `GET /api/sales/tickets` como precedente) +
   refresh al recuperar foco/online → el tablero ve mesas de otros dispositivos.
3. **Claim/guard:** decidir qué pasa ante doble edición (prohibir con aviso vs LWW con banner) —
   hoy el LWW silencioso no es aceptable para dinero/órdenes.
4. **Gate de cierre de caja:** ¿se puede cerrar turno con mesas abiertas? Precedente a favor de
   *excluir y reportar* (`arqueo.ts:51`) y de *bloquear solo evidencia sin sync*
   (`Arqueo.tsx:222`).
5. Autoridad de member para abrir/editar/cobrar sus mesas (mismo espíritu que
   `validateMemberHints`).

### Fase 3 — Resto del alcance de restaurante

- **Split / mover mesa** (dividir cuenta → 2 orders → 2 tickets; `order.table_id` mutable).
- **Comandas a cocina:** `order_line.state` (pending/sent) + impresora/kitchen display — requiere
  que Fase 1 ya haya creado `state`.
- **Board multi-sala / layout real** (`tables.x/y/sala`, salas con scroll).
- **Cobro parcial / abonos sobre cuenta** — solo si el usuario lo pide (hoy cobro es total).

### Alcance de archivos (rough)

| Fase | Archivos |
|---|---|
| **1 (local)** | `packages/shared/src/local-schema.ts` · `apps/web/src/db/local.ts` (o `local-orders.ts`) · `apps/web/src/screens/Mesas.tsx` + CSS (`app.css`/`responsive.css` o `mesas.css`) · `components/navigation.ts` · `App.tsx` (wiring) · `hooks/useSale.ts` (cargar orden en carrito) · `test/local-orders.test.ts` · `e2e/mesas.spec.ts` |
| **2 (sync)** | `packages/shared/src/mutations.ts` · `apps/api/src/db/{schema,sync-apply}.ts` · `apps/web/src/sync/{batch,rehydrate}.ts` · `apps/api/src/routes/rehydrate.ts` · `apps/api/src/db/migrate-mesas.ts` + `server.ts` · `apps/web/src/db/preservation.ts` (`BUSINESS_TABLES`) · tests: `schema-contract`, `isolation`, `sync-idempotency`, `member-sync-authority`, `reports-fixtures` |
| **3** | `screens/Sale.tsx` (split), `order_lines.state` + cola de cocina, `tables` layout, `Arqueo.tsx` (gate) |

### Riesgos principales

1. **Sync:** sin pull, el multi-dispositivo es ilusorio; LWW silencioso entre dos dispositivos
   editando la misma orden; grupos >50 y `poison` (si se eligiera A).
2. **Corte/arqueo:** cualquier estado previo al cobro **no debe sumar**; ojo con las dos semánticas
   de filtro existentes (`reports.ts:94` vs `:262`) si se toca tickets.
3. **Offline:** órdenes locales son el caso natural; el riesgo es el *doble cobro* de la misma
   mesa desde dos dispositivos (dos tickets, dos `ticket_no`) — mismo problema ya documentado de
   numeración (`FIADO.md:41`).
4. **Blast radius de tests:** `schema-contract` + `isolation` (nueva tabla en `BUSINESS_TABLES`),
   `nav-visibility`/`role-matrix` (pestaña nueva), `ui-responsive` (vista nueva), `d1-sale`/
   `modernization`/`shortcuts` si Sale cambia, `corte` si se toca el gate de cierre.
5. **Presupuesto de deuda:** elegir A impaga 4 deudas listadas arriba; elegir C+sync las evita.

---

## Preguntas abiertas (para el usuario mañana)

1. **¿Multi-dispositivo desde el día 1?** (tablet en el salón + caja, o 2 cajas). *Gate decisivo:
   si sí → Fase 1 ya con schema B y pull en Fase 2 temprano; si no → C basta.*
2. **¿Dividir cuenta / pagar por partes?** ¿y **mover una mesa** de lugar?
3. **¿Comandas a cocina** (impresora o pantalla de cocina) en el horizonte? *Si sí, `state` en
   `order_lines` desde el día 1.*
4. **¿Layout real de mesas** (posición, salas, terraza) o **solo numeración** 1..N?
5. **¿Se puede cerrar caja con mesas abiertas?** (bloquear el cierre vs permitir y arrastrar la
   orden al siguiente turno).
6. **¿El stock se reserva al sentar la mesa o solo al cobrar?** (Hoy, con C/B, es **al cobro** —
   significa que dos mesas pueden pedir el último plato.)
7. **¿Se mantiene el flujo «mostrador» (venta sin mesa) en paralelo?** (Recomendado: sí.)
8. **¿Quién puede abrir/servir/cobrar mesa?** (propuesto: cualquier rol verificado, igual que
   vender) **¿y cancelar una mesa vacía?** (propuesto: misma regla que anular.)
9. **¿Máximo de mesas / quién las da de alta?** (Dueño en Administración vs. automático.)
10. **¿Cobro parcial de una mesa** (dejar saldo) o siempre total al final?

---

## Esquema de tareas rough (mañana)

**Fase 1 — MVP local (1 dispositivo)**
- [ ] Definir DDL local `tables` / `orders` / `order_lines` (con `deleted_at` + `state`) en
      `local-schema.ts` + `BUSINESS_TABLES`.
- [ ] CRUD local: `createOpenOrder`, `listOpenOrders`, `addLine/removeLine/setQty`,
      `closeOrder→commitLocalSale`.
- [ ] Pestaña «Mesas» en `navigation.ts` + wiring en `App.tsx`.
- [ ] Board (tiles + badges Libre/Ocupada + total + tiempo) con datos reales.
- [ ] Integración: orden en curso ↔ carrito de `Sale` (mantener «mostrador» intacto).
- [ ] Cobro: reutilizar `PaymentModal` + `commitLocalSale`; cerrar orden solo tras commit.
- [ ] Guard: no desmontar/perder orden al cambiar de pestaña (hoy el carrito ya tiene ese riesgo).
- [ ] Tests: `local-orders.test.ts` (reload/crash, quitar línea, cobro, doble cobro) + e2e
      mesa→orden→cobro con capturas 1440/375.
- [ ] Doc: actualizar este archivo con las decisiones tomadas.

**Fase 2 — Sync + lectura**
- [ ] Entidades nuevas en `MUTATION_ENTITIES` + zod + `applyOne` + `groupKeyOf`.
- [ ] Schema Drizzle + `migrate-mesas.ts` + paridad (`schema-contract`) + `isolation`.
- [ ] Rehydrate (web + api) para que dispositivos nuevos vean mesas.
- [ ] `GET /api/orders/open` + refresh al foco/online en el board.
- [ ] Política de conflicto (claim vs LWW con aviso) + tests de concurrencia.
- [ ] Gate de cierre de caja con mesas abiertas (+ test en `corte`).

**Fase 3**
- [ ] Split/mover mesa · comandas (`state` + impresión) · board multi-sala · cobro parcial.

---

## Verificación (cuando se implemente — NO en este análisis)

```sh
pnpm typecheck
pnpm lint
pnpm --filter @pos/web exec vitest run --no-file-parallelism
E2E_API_PORT=3101 E2E_WEB_PORT=5181 pnpm e2e
```

> **Estado:** análisis completado en `1826325` (árbol solo con este archivo sin trackear).
> **Fase 1 IMPLEMENTADA** — ver «Decisiones tomadas» abajo (gate completo: typecheck, lint,
> shared+web+api unit y e2e completo en verde; sin builds, sin commits, sin DB de dev).

---

## Decisiones tomadas (Fase 1 · para mañana)

### Del arquitecto (las 6 que gobernaron el encargo)

1. **Datos en LOCAL PGlite con referencias, no JSON.** `order_lines` guarda
   `variant_id` (FK lógica) + `name` denormalizado para leer la comanda sin joins;
   nada de payloads JSON embebidos (rompería la paridad y el query por variant).
2. **`deleted_at` + `state` desde el día 1.** `order_lines.deleted_at` (soft-delete)
   y `orders.state ∈ {open, cancelled, closed}` existen ya en el DDL: Fase 2 los
   convierte en entidades de sync **sin migración de datos**.
3. **Cart state de Sale: `activeTableId: string | null`** + banner
   «Atendiendo: [Nombre Mesa]». El id vive en `App` (sobrevive al unmount de Sale al
   cambiar de pestaña); el nombre se resuelve con `getTable` en un effect.
4. **Ticket recién al cobro + stock debitado AL COBRAR.** `commitLocalSale` queda
   INTACTO (una tx: ticket + líneas + payments + stockdiary + stock + cola). No hay
   `stockdiary` ni fila de venta antes del cobro; la comanda no toca stock.
5. **Roles.** «Mesas» es `tier: "all"` (mismo tier que Venta: atender = vender);
   «+ Agregar Mesa» y el CRUD de Admin son solo Dueño/Admin (`isDueñoHint`).
6. **`total_amount` derivado, puro.** Nunca se almacena: `SUM(price*qty) WHERE
   deleted_at IS NULL` en cada lectura del board — imposible que desincronice.

### De implementación (mías)

7. **Board → POS, NO drawer.** Click en «Abrir / Cobrar» carga la comanda en el
   carrito existente y navega a Venta. Justificación: reutiliza grilla, oversell,
   atajos, `PaymentModal` y `commitLocalSale` sin duplicar una segunda superficie de
   carrito/cobro; un drawer exigiría replicar el modal de pago y el manejo de
   `busy`/errores (deuda nueva, cero beneficio). Menos fricción = una sola pantalla
   para servir.
8. **`order_lines.variant_id`, no `product_id`.** El precio y el stock viven en la
   variante y `commitLocalSale` recibe `variant_id`; una referencia al producto no
   podía precioar una línea ni cobrarla. (Desviación explicita del «product_id» de
   la spec, a favor de la corrección técnica.)
9. **«Guardar en Mesa» = reemplazo atómico en UNA tx.** Inserta líneas nuevas,
   actualiza las cambiadas y soft-deletea las ausentes; el board nunca observa una
   comanda a medias. La soft-delete ocurre al guardar (no línea por línea al tocar
   «✕» en el carrito): el carrito es la copia de trabajo y la orden solo se escribe
   de forma completa. Borrar nunca es `DELETE`.
10. **«Cobrar» con mesa = guardar implícito + recarga completa.** Antes de abrir el
    `PaymentModal`, `prepareCheckout()` persiste el carrito en la comanda y vuelve a
    cargar TODAS las líneas: el ticket no puede perder consumo ya guardado (riesgo
    real si el cajero cobrara solo lo que tiene en el carrito).
11. **`commitTableSale` exige orden abierta ANTES del ticket.** Pre-check
    `ORDER_NOT_OPEN` → sin ticket, sin pago, sin stock. Segundo cobro = cero filas
    nuevas. El cierre (`state=closed`, mesa `available`, `current_order_id=null`,
    `opened_at=null`) corre solo después de que el ticket existe.
12. **Guard de salida = confirmación, nunca destrucción silenciosa.** Verificación
    previa: **el carrito NO sobrevive hoy al cambiar de pestaña** — `Sale` se
    monta condicionalmente (`App.tsx` `tab === "sale"`) y `useSale` es `useState`,
    así que el unmount lo pierde (ya estaba documentado en `CONTROL-MESAS.md` §1).
    El guard agrega el diálogo «Tenés consumos sin guardar ni cobrar — ¿descartar?»
    (Quedarse / Descartar) ANTES de salir; «Descartar» limpia `activeTableId` y deja
    que el carrito muera con el unmount (mismo destino de siempre, ahora elegido).
    No se escribió ninguna persistencia nueva del carrito.
13. **Posición en `navigation.ts`: DESPUÉS de Catálogo.** `compactNavigation` entrega
    al tabbar móvil `nav.slice(0, 4)`; meter «Mesas» en la posición 2 empujaba
    `Catálogo` a «Más secciones» y rompía ~10 specs que abren el catálogo con click
    directo a 375px. Descubierto corriendo el e2e (el mobile de mesas falló con
    «Sin productos»). Queda: primario `[Venta, Caja, Tickets, Catálogo]` intacto.
14. **Banner + «Guardar en Mesa» en una fila de contexto arriba del POS** (visible en
    ambos breakpoints). NO en el panel de orden (tiene `overflow: hidden` + tests de
    geometría que exigen que sólo `.order-lines` scrollee) ni en el `cart-bar` móvil
    (altura fija de 80px vía `--checkout-height`).
15. **`tickets.table_name` = la única pieza servidor de Fase 1.** Columna aditiva
    nullable en AMBOS esquemas (`TICKET_TABLE_NAME_MIGRATION_SQL` en
    `LOCAL_SCHEMA_SQL` + `migrate-mesas.ts` en el boot del server), zod
    (`table_name` opcional), `sync-apply` (insert + onConflict sin borrar lo legacy),
    rehydrate web, y `schema-contract` cubre `tickets` en los dos lados.
16. **Mesas/órdenes SÍ entran en `BUSINESS_TABLES` (18 filas)** — logout/switch de
    tenant las limpia (una tabla nueva ausente = fuga entre tenants) — pero NO
    entran en `sync_log` ni en el rehydrate: siguen siendo locales hasta Fase 2.
17. **`MESAS_MIGRATION_SQL` corre solo en el open path de PGlite**, aparte de
    `LOCAL_SCHEMA_SQL`: ese string es también el `BASELINE_SQL` del server, y el
    server no debe tener tablas de comandas todavía. Idempotente ⇒ sin bump de
    `DATA_DIR_VERSION`.
18. **Desactivar una mesa con comanda abierta está bloqueado** (`TABLE_IN_USE`) —
    liberar o cobrar primero. Nunca se destruye una comanda en silencio (mismo
    principio que el guard de salida).
19. **Zonas:** `<select>` con las 3 existentes + «Otra…» que revela un input libre.
20. **«Pedir cuenta» = `tables.status = 'billing'`**, la orden sigue `open` (se puede
    seguir agregando; volver a guardar la devuelve a `occupied`).

### Verificación previa (lo que se leyó antes de escribir código)

- **Carrito hoy:** memoria efímera (`useSale.ts:35`), se pierde al desmontar `Sale`
  al cambiar de pestaña; sobrevive Escape/cerrar modal/error de commit; `setLines([])`
  solo corre tras un commit exitoso. El guard confirma eso, no lo cambia.
- **`PaymentModal`** es el único camino de cobro (3 métodos) y no se tocó: la comanda
  se cobra exactamente igual, con el total de la orden.
- **`commitLocalSale`** sigue siendo UNA transacción ticket+lines+payments+stockdiary+
  stock+sync_log; solo se le agregó el campo aditivo `table_name`.
- **Invariante de ticket recién al cobro:** intacto — no existe fila de venta hasta
  que el cajero confirma el cobro.
- **Nada contradujo la spec**: `table_name` en tickets era viable con el patrón
  aditivo existente (`customer_id`, `unit_cost`), así que no hubo que forzar nada.

### Riesgos / pendientes (para Fase 2)

- **Push-only:** una mesa abierta en la tablet no aparece en la caja hasta que esa
  caja rehidrate (mismo límite de siempre). El pull (`GET /api/orders/open` + refresh
  al foco) sigue siendo la feature que habilita «mesa en la tablet, cobro en la caja».
- **`closeTableOrder` corre en una tx separada del ticket** (pre-check → commit →
  cierre). En el flujo real es secuencial con el `busyRef` del modal y pestaña única;
  una falla de DB entre medias dejaría la mesa ocupada con el ticket emitido (la mesa
  se libera desde el board con «Liberar»). Aceptado para Fase 1.
- **Cobro parcial / split / mover mesa** siguen fuera de alcance (Fase 3).
- **Gate de cierre de caja con mesas abiertas** sin tocar (Fase 2, §4).

---

## Fase2 implementada — decisiones (multi-dispositivo)

> **Gate completo en verde** (un worker, secuencial, árbol sin staged/commits,
> sin builds, sin DB de dev, dev server intacto):
>
> | Paso | Resultado |
> |---|---|
> | `pnpm typecheck` (`-r`) | shared + api + web → **0 errores** |
> | `pnpm lint` (`eslint .`) | **0 problemas** |
> | `pnpm --filter @pos/shared test` | **3 archivos · 50 tests** ✓ |
> | `pnpm --filter @pos/web exec vitest run --no-file-parallelism` | **18 archivos · 190 tests** ✓ |
> | `pnpm --filter @pos/api exec vitest run` | **31 archivos · 297 tests** ✓ |
> | `E2E_API_PORT=3101 E2E_WEB_PORT=5181 pnpm e2e` | **102 passed · 0 failed (11.7 m)** ✓ |

### Decisiones tomadas

1. **Entidades `table` / `order` / `order_line` byte-al-patrón.** Las tres en
   `MUTATION_ENTITIES` + zod (`shared/mutations.ts`) + `applyOne`/`upsertEntity`
   + `groupKeyOf` (`sync-apply.ts:groupKeyOf`), upsert LWW por mutación con
   `client_ts` como en todas. `unique(tenant_id, client_uuid)` en ambas
   DDL; `client_uuid` aditivo con backfill `= id` en los datadirs Fase 1.
   Agrupación: cliente (`batch.ts`) y servidor comparten la clave
   `order:{order_id}` (orden + líneas = UN grupo, como una venta); el
   `table` viaja SOLO con dependencia topológica (`table_id`) para aterrizar
   antes que su comanda.
2. **«Guardar en Mesa» = mutaciones POR LÍNEA (no era wipe-and-reinsert).**
   Verificado: `saveOrderToTable` ya hacía upsert por `variant_id` +
   soft-delete de faltantes **en una sola tx**; lo que Fase 1 no hacía era
   encolar. Fase 2 agrega, en la MISMA tx: `order_line` por cada línea
   cambiada/insertada (client_uuid estable = id de la fila), `deleted_at` como
   ESTADO en la mutation de las removidas, y `order` refrescado en cada
   guardar. Dos dispositivos guardando líneas distintas no se pisan: cada
   línea resuelve por LWW independiente. **Ningún test de Fase 1 tuvo que
   romperse** (las transiciones pasan porque el board ya derivaba).
3. **Doble cobro — doble defensa, sin claims/leases:**
   - **(a) Frescura en `prepareCheckout`** (el choke-point que comparten
     todos los entry points de cobro, ANTES del modal): `GET /api/orders/open`
     ⇒ si la orden está en `closed_orders` (tombstone) o el server tiene
     OTRA comanda abierta en esa mesa ⇒ bloqueo con «Esta mesa se cobró en
     otro dispositivo — el tablero se actualizó» (o «se está atendiendo en
     otro dispositivo» para el fork), `pullOpenOrders` inmediato + refresh
     vía `onStaleOrder` → `refreshToken`. Offline/sin respuesta ⇒ sin check
     (offline-first).
   - **(b) Backstop server: `tickets.order_id` único** (índice parcial
     `WHERE order_id IS NOT NULL` en AMBOS schemas + pre-check en-tx
     `ne(id, cu)`). Manejo idéntico al oversell backstop: pre-check ⇒
     `InvalidSync` ⇒ `rejected: validation`; carrera de índice ⇒
     `rejectedConstraint()` mapea el 23505 de esos dos índices
     (`tickets_tenant_order_id_uq`, `orders_tenant_table_open_uq`) a
     `validation`, **NUNCA a `db_error`** — eso era justamente el «estado
     malo de cola» que el encargo mandaba reportar antes de inventar:
     `db_error` reintenta para siempre y apararía un cobro duplicado en la
     cola. Con `validation` el cliente sigue el patrón existente:
     determinista → `poison` a los 3 intentos (aislado, visible, preservado,
     con «Reintentar tras corregir» en el banner). **Test: misma sesión y
     DOS sesiones concurrentes ⇒ exactamente 1 ticket, perdedor con
     `reason: "validation"`.**
4. **Pull `GET /api/orders/open`** (tenant-scoped, `requireAuth` — miembros
   incluidos, `Cache-Control: no-store`): tableros derivados
   (`available|occupied|billing` + items/total con el mismo math local),
   comandas `open` (billing como flag `billing_at`), TODAS sus líneas
   (incl. soft-deleteds, para replicar remociones) y `closed_orders`
   (tombstones acotados a 200). `Mesas.tsx` refresca con RE-FETCH en: montar
   la pestaña, `focus`, `online` y cambio de `refreshToken` (tras
   guardar/cobrar) — nunca reload. Merge en `sync/open-orders.ts`: filas con
   mutación local en vuelo NO se pisan (la excepción son los tombstones:
   verdad terminal del server > fantasma «ocupada»), upsert del resto,
   guardas de divergencia (comanda bifurcada + nombre de mesa duplicado).
5. **Rehydrate (web + api) con paginación de Tanda 2.** `tables`, `orders` y
   `order_lines` (líneas de ESTA página de órdenes, patrón `listByTickets`)
   vuelan en cada página de `GET /api/rehydrate` y entran al local con
   `ON CONFLICT DO NOTHING`. Test: fixture con órdenes ⇒ dispositivo nuevo
   las ve en el board (lado API) + `applyRehydratePage` (lado web).
6. **Cierre de caja bloqueado con mesas abiertas.** En `Arqueo.handleClose`,
   después del flush online: `N` = unión de órdenes locales abiertas y las
   del server (si responde) ⇒ `«Hay N mesas con comandas abiertas — cobralas
   o libralas antes de cerrar»` (visible, `arqueo-error`). Data-layer backstop
   en `closeLocalShift` (`OPEN_ORDERS_EXIST`) para el path offline y para la
   carrera entre pantalla y tx. Tests: unit (`arqueo-local`) + e2e en
   `corte.spec` (bloquea → liberar → cierra).
7. **Estado de mesa: DERIVADO (decisión 8 elegida — derivar).** Todo lector
   (`listTables`/`getTable`/`listBoardTables`/`loadTableOrder`/
   `ensureOpenOrder`/`closeOrCancel`/`setTableBilling`/guardia
   `TABLE_IN_USE`) pasa a `LEFT JOIN LATERAL` sobre la comanda `open` más
   antigua. `tables.status/current_order_id/opened_at` quedan como columnas
   LEGACY en ambos DDL (paridad + datos viejos), **sin leer ni escribir**;
   «Pedir cuenta» es `orders.billing_at` (muere con la orden). Superficie de
   conflicto LWW sobre mesas reducida a CATÁLOGO (name/zone/capacity/active).
   Tests Fase 1 de estado pasaron sin cambios porque ya asumían la
   normalización por join.
8. **Autoridad de member.** `table` es catálogo ⇒ prohibido para
   `member` (pre-scan de la ruta + `validateMemberHints`, mismo trato que
   category/product — decisión #5 de Fase 1 server-side). `order`/`order_line`
   abiertos a cualquier rol: atender mesa ES vender. Test incluido.
9. **Terminalidad de comanda.** `closed`/`cancelled` son FINALES en el
   server (guard igual al de `payments` en `sync-apply`): un `open` LWW de un
   dispositivo viejo jamás resucita una comanda cobrada.
10. **Backfill de upgrade (Fase 1 → Fase 2).** Las mesas/comandas que Fase 1
    dejó SIN sync_log se encolan una vez por boot (`backfillMesasMutations`,
    antes del primer drain): TODAS las mesas + comandas ABERTAS y sus
    líneas. El histórico Fase 1 cerrado queda device-local a propósito (ningún
    otro dispositivo lo vio abierto; sus tickets ya llevan `table_name`).
    Idempotente y jamás pisa una edición encolada (test).
11. **`table_name` + `order_id` en tickets.** El ticket del cobro lleva
    `order_id` en payload/DB — es la llave del backstop (b). Los counter
    sales mandan `null` (el índice parcial los ignora).

### Límites documentados (a propósito)

- **Ventana de carrera residual (a)→(b):** entre el fetch de frescura y el
  commit pueden pasar segundos (el cajero cuenta el efectivo). Si otro
  dispositivo cobra en esa ventana, gana (b): exactamente 1 ticket; el
  perdedor queda `rejected: validation` → `poison` visible en el banner de
  sync con «Reintentar tras corregir». **No hay claims/leases** (decisión).
- **Stock SIN reservas:** igual que Fase 1 — se debita recién al cobro
  (`commitLocalSale` intacto); dos mesas pueden pedir el último plato y el
  backstop de oversell server sólo actúa en el cobro. Reportes NO invadidos.
- **Cobro con OFFLINE en la frestura:** sin fetch no hay check (offline-first);
  el backstop (b) sigue aplicando cuando la cola drena.
- **Gate de cierre de caja es CLIENT-side** (pantalla + `closeLocalShift`).
  El endpoint server `POST /api/shifts/:id/close` NO valida mesas: una mesa
  abierta en OTRO dispositivo después del check del cliente puede colar un
  cierre online (ventana de milisegundos, post-flush). Aceptado; subirlo al
  server arriesga envenenar cierres legítimos por carrera (reportado, no
  inventado).
- **Comanda bifurcada (dos dispositivos offline abren la misma mesa):** el
  server acepta UNA (`orders_tenant_table_open_uq`), la del otro dispositivo
  queda `poison` + guardas de merge/frescura impiden servirla; se resuelve
  «Liberando» la local (el push del `cancelled` limpio pasa el guard
  terminal). Sin merge automático (LWW sin merge, como todo el protocolo).
- **Comanda con >48 líneas:** el grupo (1 orden + N líneas) supera el cap
  `MUTATION_BATCH_MAX=50` y cae al path de snapshot de venta que exige
  ≥1 payment ⇒ rechazo determinista ⇒ `poison`. Límite heredado del diseño
  de Fase 1 (documentado, no nuevo); en la práctica una comanda típica queda
  muy por debajo.
- **Tombstones acotados:** `closed_orders` = 200 filas más recientes; si el
  server no conoce una orden local pendiente de push, no se concluye nada
  (la frestura solo bloquea con evidencia: tombstone u otra orden abierta).
- **Tablas en el pull:** tope 500 por respuesta; colisión de nombre activo
  entre una mesa local y una remota queda en «operatoria» (skip + board local),
  nunca aborta la transacción de merge.
- **Histórico Fase 1 cerrado no se sincroniza** (ver backfill) — solo
  afecta a datos previos a este deploy.

### Qué NO se hizo (sigue en Fase 3)

- Split / mover mesa, comandas a cocina (`order_lines.state` + impresora),
  board multi-sala/layout, **cobro parcial / abonos sobre cuenta**,
  reutilización de tickets. Nada de eso fue pedido en esta fase.
- Sin columnas nuevas en reportes/arqueo (excepto el gate del punto 6, que
  es de UI+data-local, no de reportes).
- Sin `op: delete` (todo es estado/upsert, como el protocolo actual).

### Tests nuevos / actualizados

- **Nuevos API:** `apps/api/test/mesas-sync.test.ts` (14): idempotencia
  double-push de las 3 entidades, LWW de línea, guard terminal, un-open-por-
  mesa, doble cobro misma sesión y DOS SESIONES concurrentes (exactamente 1
  ticket + rechazo `validation`), counter-sale intacto, `GET /api/orders/open`
  (401 / no-store / estado derivado / billing / tombstones / member 200 /
  tenant-scoped), rehydrate con fixture de órdenes, autoridad de member.
- **Actualizados API:** `schema-contract.test.ts` (+3 tablas en
  `SHARED_TABLES`, +10 índices en `EXPECTED_INDEXES`, uniques por cliente y
  test de los 2 índices parciales nuevos).
- **Nuevos web:** `apps/web/test/open-orders.test.ts` (7: rehydrate de
  comandas, pull, offline-first, no-pisar-ediciones-en-coladas, tombstones,
  fork guard) y en `local-orders.test.ts` (+4: encolado por escritura,
  backfill idempotente) y `arqueo-local.test.ts` (+1: gate de cierre).
- **E2E:** `mesas.spec` — comentario «device-local» reescrito con honestidad
  (liberar SÍ empuja `order=cancelled`, sigue sin ticket/pago/stock), poll
  para server-truth del cobro directo, y test NUEVO «otro dispositivo»:
  mesa abierta seedeada vía `POST /api/sync/mutations` ⇒ aparece tras
  `focus`, es servible (retoma la comanda) y la segunda aparece tras
  re-entrar al tablero. `corte.spec` — test NUEVO del gate de cierre
  (bloquea con el conteo → liberar → cierra) + restauración del turno abierto
  (patrón `cash-movements.afterEach`; sin eso la anulación de `fiado` rompe
  porque exige turno abierto — descubierto y corregido en el gate).
  `helpers-db.wipeSalesAndCatalog` ahora limpia `order_lines/orders/tables`.

### Archivos (mapa)

- **Shared:** `mutations.ts` (3 entidades + zod + `ticket.order_id`),
  `local-schema.ts` (`MESAS_MIGRATION_SQL` con client_uuid/billing_at/
  order_id + índices parciales, interpolada en `LOCAL_SCHEMA_SQL` = baseline).
- **API:** `db/schema.ts` (+3 tablas Drizzle + `tickets.order_id`),
  `db/sync-apply.ts` (groupKeyOf/rank/applyOne/catch), `db/scope.ts` (repos),
  `db/migrate-mesas.ts` (DDL completo), `sync/route.ts` (member vs `table`),
  `routes/rehydrate.ts` (+colecciones), **`routes/orders.ts` (nuevo GET)**,
  `app.ts` (registro).
- **Web:** `db/local-orders.ts` (deriva + enqueues + backfill + count),
  `db/local.ts` (`order_id` en ticket + gate `closeLocalShift`),
  **`sync/open-orders.ts` (nuevo pull/frescura)**, `sync/rehydrate.ts`
  (+colecciones), `sync/batch.ts` (grupos `order:` + deps), `screens/Mesas.tsx`
  (re-fetch focus/online/montaje), `screens/Sale.tsx` (frescura),
  `screens/Arqueo.tsx` (gate), `App.tsx` (backfill + `onStaleOrder`),
  `db/pglite.ts` (comentario del open path).
- **E2E/tests:** `mesas.spec`, `corte.spec`, `helpers-db.ts`,
  `test/mesas-sync.test.ts`, `test/open-orders.test.ts`,
  `test/local-orders.test.ts`, `test/arqueo-local.test.ts`,
  `test/schema-contract.test.ts`.

### Pendientes / deuda conocida

- Subir el gate de cierre al server `POST /api/shifts/:id/close` (requiere
  resolver la carrera de cierre legítimo vs. mesa abierta tardía — hoy
  documentado arriba).
- Aislamiento cross-tenant de `tables/orders/order_lines` en
  `isolation.test.ts` (la varita de 12 tablas de D4-3 no se extendió; la
  lectura cross-tenant del pull SÍ está cubierta por el test de authz).
- `op: delete` / merge real entre comandas bifurcadas: fuera de alcance.
