# NEXORA — fiado: crédito, saldos por cliente y abonos

## Encargo y UI

- **Público:** dueños y cajeros de comercios colombianos que venden a crédito (fiado) con cortes de conexión.
- **Objetivo/oferta:** registrar ventas a crédito y cobros (abonos) sin perder trazabilidad, con saldo por cliente verificable en ambos stores y offline.
- **Vistas:** Clientes & Fiados (tarjetas, alta/edición, detalle, abono) · cobro **Fiado** dentro del modal único de Venta · Tickets (filtro/badge/detalle de crédito, guardia de anulación) · Caja (abonos en efectivo entran al esperado de gaveta) · Panel/Reportes (columnas `Crédito` y `Abonos (cobros)`).
- **CTA principal:** «Nuevo Cliente Fiado» (tarjetas) y «Registrar Abono» (tarjeta/detalle, solo owner).
- **Contenido real:** nombre/teléfono/límite/saldo del tenant; importes COP enteros en `es-CO`; fechas Bogotá. Sin datos de muestra (no Carlos Arango, no NIT, no deudas ficticias).
- **Tono:** operativo NEXORA; mensajes explican saldo/ límite / turno antes de bloquear.
- **Restricciones:** React/CSS/Lucide actuales, PGlite + Postgres, cola durable idempotente, permisos existentes. **IVA DIFERIDO (B1):** no hay fila fiscal en carrito ni recibo; precios/totales intactos; no se afirma IVA19% ni exención (tarea 15.1 fuera del alcance).

## Contrato y decisiones

### Modelo de datos

- `customers` — tenant, nombre (1–120), teléfono, notas, `active`, `credit_limit integer` nullable (**sin backfill**), `client_uuid` único por tenant. **No hay columna de saldo:** el saldo siempre se deriva.
- `credit_abonos` — importe entero `> 0`, `method cash|transfer`, `customer_id` (obligatorio), `shift_id` (obligatorio), `ticket_id` opcional («Sin aplicar (cliente)»), nota opcional. **Los abonos NUNCA son `payments`** y nunca crean ticket ni aumentan ingresos.
- `tickets.customer_id` nullable — atribución de la venta de crédito. **`payments.customer_id` fue DROPEADO** (decisión D2): la fuente única es la columna del ticket; una fila espejo solo agregaría una invarianza sin beneficio de consulta.
- Dos filas de pago para venta mixta (D1): fila efectivo (`confirmed`, con `tendered`/`vuelto`) + fila crédito (`confirmed`, sin importe recibido), ambas con el `shift_id` del ticket; la suma es exactamente el total por construcción.

### Fórmulas

- **Saldo (balance)** = `Σ pagos credit confirmados en tickets no anulados − Σ abonos` — una sola fórmula compartida (`CUSTOMER_BALANCES_SQL` / `CUSTOMER_ACCOUNTS_SQL` en `packages/shared/src/reports.ts`), misma salida en PGlite y Postgres.
- **Por Cobrar (reporte/endpoint)** filtra `balance > 0` (conflicto #4, gana el spec): cero/negativo no es «por cobrar».
- **Vista Clientes & Fiados** muestra **TODOS los activos**, incluidos saldo 0 («Al Día») y negativo; el límite y «crédito usado / cobrado» son visibles por tarjeta. Un cliente en cero no desaparece de la vista aunque desaparezca del reporte.
- **Límite de crédito:** entero ≥ 0. `null` = sin configurar (legacy: se puede cobrar pero se pide configurar antes de una NUEVA venta fiada); `0` = no concede crédito nuevo (NO es ilimitado). Bloqueo `CREDIT_LIMIT_REQUIRED` / `CREDIT_LIMIT_EXCEEDED` se calcula **en la MISMA transacción local** del commit sobre el saldo conocido (`balance + parte_crédito ≤ credit_limit`, igualdad permitida).

### Gates de permisos

- **Abono: owner-only.** En UI el formulario solo se renderiza con rol `owner` verificado (server sigue siendo autoridad; rol desconocido → nunca owner). En sync, el rechazo es **por ítem** en la ruta (`rejected: validation`), NO HTTP 403: un abono de miembro no debe matar el lote de venta del miembro (D4).
- **Anulación: 409 `abonos_exist` a nivel de cliente** — ver `ANULACIONES.md`. Precedencia `not_found → shift_closed → abonos_exist → incomplete_sale`.
- **Ventas:** el cliente debe existir (tenant-scoped) antes de aplicar la venta de crédito; el server rechaza el grupo y el cliente reordena/reintenta (H7).

### Decisiones de negocio registradas

- **B1 — IVA diferido (2026-11-11):** no se implementa tributación; se omiten filas fiscales; precios/totales intactos; no implica exención ni tasa cero.
- **B2 — gaveta física aprobada, solo turnos nuevos:** `drawer_cash_v2 = base + ventas efectivo + abonos efectivo + ingresos − retiros`; **transferencias y abonos por transferencia van aparte**. Abonos en efectivo SÍ entran al esperado de gaveta; abonos por transferencia NO. Versión explícita en turno y cierre; turnos previos (incluido el abierto al activar) y snapshots cerrados conservan `legacy_v1` y sus valores. Ver `MODERNIZACION.md`.
- **Sin F3:** el spec `CRD:Shortcuts unchanged` gana sobre la recomendación del diseño §7.1. F1/F2/Enter operan el MISMO modal de cobro (un solo commit); F3 no hace nada.
- **Cupo offline es LOCAL, no global (límite documentado, NO resuelto):** la garantía de límite es una barrera atómica sobre el saldo conocido en el dispositivo. Dos dispositivos offline pueden vender a crédito concurrentemente y la suma convergida puede superar el límite; el servidor conserva esas ventas reales (rechazarlas las convertiría en poison) y la cuenta queda «excedida» visible tras converger. No se implementó reserva online (sacrificaría el crédito offline). Evidencia: test de concurrencia 120000/100000 en `local-customer.test.ts` / `credit-sync.test.ts`.
- **Numeración de tickets offline NO resuelta:** el contrato preexistente `tickets_tenant_ticket_no_uq` + `MAX(ticket_no)+1` local puede rechazar dos tickets offline con el mismo número. M2/M9 no implementan asignación global de números; no confundir la garantía de cupo con solución de esta colisión.

## Sync y caché

- **Entidades nuevas** `customer` y `credit_abono` en el envelope (`MUTATION_ENTITIES` + schemas zod); `payments.method` acepta `credit`; `ticket.customer_id` es **opcional** en el payload (los tickets encolados legacy sin la clave siguen válidos). `tenant_id` forjado se elimina en el parse.
- **Orden cliente-antes-de-venta (H7):** `batch.ts` agrega `customer_id` a los campos de dependencia; el cliente viaja en grupo `solo` y drena ANTES del grupo de la venta. `sale-stage.validateSale` NO cambia: sigue rechazando entidades de cliente dentro de un snapshot de venta (tripwire `sale_mixed_entities`). Venta grande (>50 mutaciones) snapshottea solo el grupo de venta.
- **Inmutabilidad del abono (9.5):** una fila existente de `credit_abono` no admite cambios de importe/método/cliente/turno/vínculo/nota/timestamps; replay idéntico → `duplicate`; contenido distinto (incluso con `client_ts` posterior) → rechazo SIN avanzar ledger ni reescribir la fila. Clients/catálogo siguen LWW normal.
- **Rehidratación [H6]:** página 0 del server trae **todos** los `customers` (incluidos inactivos y límites); `credit_abonos` paginados con continuación; el cliente inserta ambos, conserva `tickets.customer_id` y también `ticket_lines.unit_cost` (M1 corrigió esa pérdida). Reintentos no duplican ni reencolan.
- **Wipe/aislamiento [H6]:** `BUSINESS_TABLES` (15 tablas, incluye `customers`, `credit_abonos`, `cash_movements`) alimenta logout/upgrade/tenant-switch; falta una tabla = fuga entre tenants en dispositivo compartido. Sweep server-side en `isolation.test.ts`.
- **Abono offline:** la fila + la cola se insertan en UNA transacción; `pushNow` solo al confirmar (fuera de la tx). Recibe turno abierto requerido (`SHIFT_REQUIRED`) y validación de saldo en el mismo tx; sobrepago se rechaza (no se recorta), cero/fraccionarios/negativos se rechazan.
- **Éxito honesto:** el toast dice «(pendiente de sync)»; nunca afirma confirmación bancaria. La venta a crédito queda `completed` con claim confirmado (no hay flip pending→confirmed para crédito).

## Verificación y evidencia

- **Suites:** `packages/shared/test/{mutations,methods}.test.ts` · `apps/api/test/{credit-sync,credit-limit,reports-fixtures,void-sale,sync-idempotency,sale-stage,arqueo*,isolation,schema-contract}.test.ts` · `apps/web/test/{local-sale,local-customer,reports-local,arqueo-local,void-sale,sale-upload,preservation}.test.ts` · `e2e/{fiado,modernization,palette,void-sale,corte,panel-attention}.spec.ts`.
- **Fixtures fijas (Day3 Bogotá):** crédito 55.000 + efectivo 10.000 → ingresos 65.000; abonos 8.000 (5.000 cash + 3.000 transfer) como COBROS, no ingresos; balances X=30.000 / Y=17.000 exactos en ambos stores.
- **E2E:** alta desde el cobro, bloqueo de límite sin escritura, split mixto exacto, abono ≠ ingreso (1 ticket / 1 payment / 1 abono), offline/reload/replay idempotente, sesión member sin formulario de abono, matriz cross-view M9 (búsqueda por teléfono/acentos, dinero inválido sin escritura, void 409 `abonos_exist` sin mutar abonos, atajos F1/F2 no cobran a través de la paleta).
- **Capturas** 1440/375 en `/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode/` (`m5-*`, `m6-*`, `m9-*`).

## Despliegue (checklist — se ejecuta en 17.3, NO aquí)

1. **API primero** (enums ampliados + claves nuevas de rehydrate + DDL aditivo); el web viejo sigue funcionando contra la API nueva (compatibilidad legacy verificada: payloads sin `customer_id`/límite siguen parseando).
2. Verificar cash/transfer del build web viejo contra la API nueva.
3. **Web después.**
4. **Rollback:** primero volver el tag del web; la API solo si hace falta (el schema aditivo queda inofensivo). Precedente `SKU.md:22`.
5. Activar políticas según B1/B2 al desplegar; `drawer_cash_v2` solo en turnos abiertos NUEVOS después del rollout. Fuentes/SW offline confirmarse en el artefacto desplegado (prohibido build desde planificación).

> **Estado:** implementado y verificado en local (gate M9). **Despliegue pendiente (17.3)** — sin entorno autorizado en esta fase.
