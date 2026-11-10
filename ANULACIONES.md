# NEXORA — batch: anulación total auditable

## Encargo y UI

- Público: dueño del comercio; personal continúa vendiendo online/offline.
- Objetivo/oferta: corregir una venta completa sin borrar evidencia ni duplicar la restitución de inventario.
- Vista: Tickets → detalle → «Anular venta completa» → motivo → confirmación total.
- Contenido real: número, fecha, líneas, pago e importe originales; motivo real de la anulación.
- Tono: operativo, directo; explicar conexión y límite de caja cerrada antes de confirmar.
- Referencia visual/fuente de reglas: Tickets/Caja existentes y `apps/web/src/app.css` (tokens, 48px de tap, 8/12px de radio, breakpoints). Reutilizar componentes; diálogo nativo con foco, Escape y retorno al disparador; sin animación nueva. No se introduce una estética externa en este cambio incremental.
- Restricciones: stack actual, COP enteros, no build, sin pagos reales/DIAN/infra; una terminal por tenant.

## Contrato y decisiones

`POST /api/sales/tickets/:id/void` recibe **solo** `{ reason }` (trim, 3–500 caracteres).
Owner del tenant de sesión; miembro → 403, ticket ajeno/inexistente → 404, motivo inválido → 400.
Venta sin turno abierto, turno cerrado o arqueo ya persistido → 409 `shift_closed`.
Venta parcialmente sincronizada/inconsistente → 409 `incomplete_sale`.

Una transacción bloquea ticket y turno; verifica líneas, subtotales, pagos y movimientos de venta persistidos. No usa un total/estado/cantidad enviados como orden de reversión. Marca ticket `voided`, conserva total/líneas/pagos originales, agrega `audit_log` (`sale.void`, actor de sesión, fecha, motivo, estado/total originales). Por variante agrega un movimiento `sale_void`, con UUID estable derivado de tenant/ticket/variante y conflicto único; recalcula stock desde el diario. No borra ni edita movimientos originales. Dos anulaciones concurrentes/reintentos conservan la primera auditoría y la misma compensación. Un reintento de una anulación ya realizada también responde después del cierre sin tocarlo.

**Semántica contable:** ventas por día, top productos, ingresos/pendientes/COGS del dashboard y esperado de caja excluyen el ticket anulado. Inventario incluye la restitución. Se usa la fecha de la venta para los reportes netos; el evento de anulación conserva su fecha en auditoría/diario. El arqueo cerrado es una foto inmutable. No hay anulación posterior al cierre en este batch: requeriría un libro de ajustes/reintegros en otro turno. Elegimos el rechazo explícito para evitar alterar cajas conciliadas.

**Dinero:** esta acción registra una anulación contable y restitución de stock; no ejecuta transferencias/reintegros bancarios ni verifica la entrega física de efectivo. Si corresponde devolver dinero, se hace por fuera de NEXORA. No es una devolución parcial.

## Sync y caché

- `voided`/`refund` no son estados admitidos por los payloads ordinarios. `sale_void` está reservado al comando server; no se puede fabricar ni editar por sync.
- Sync bloquea ticket y verifica tanto padre declarado como padre persistido de líneas/pagos/diario. Un ticket anulado congela todo su grupo, incluso contra LWW con timestamp nuevo o padre falsificado. Replay idéntico → duplicate; contenido alterado → rejected. Ambos llevan `voided_ticket` para recuperar estado canónico.
- El ACK de un replay trae señal canónica: el cliente obtiene detalle/diario del servidor antes de dar por sincronizada la fila. Si falla la lectura, queda pendiente de reintento. El mirror agrega únicamente deltas nuevos (idempotencia por UUID), conserva ventas offline posteriores y no encola una acción privilegiada.
- La UI sincroniza la cola antes del comando; si quedan pendientes o errores, pide resolverlos. Si se pierde el ACK del comando, reintentar es seguro.
- El stock recibido en un refresh de variante ya no gana sobre el diario. Se conserva costo omitido por clientes viejos y los refreshes nuevos de venta/ajuste incluyen costo.
- Transferencias confirmadas no se pueden desconfirmar con sync; la primera confirmación requiere el endpoint owner existente. La confirmación también bloquea el ticket y rechaza uno anulado.
- La cola agrupa ventas antes de aplicar el límite HTTP de 50; no parte una venta entre requests legacy. Actualización posterior: grupos mayores usan staging durable + finalize atómico, documentado en `SYNC-VENTAS-GRANDES.md`; no se subió el límite legacy ni se aplican partes como ventas completas.
- El cierre offline calcula `expected`/`diff` en servidor con SQL compartido y devuelve valores canónicos en ACK para actualizar la copia local. Un arqueo existente nunca se reescribe. Un replay de apertura no reabre un turno con arqueo.

## Verificación y evidencia

Pruebas nuevas: `apps/api/test/void-sale.test.ts`, `apps/web/test/void-sale.test.ts`, `e2e/void-sale.spec.ts`.
Cubren efectivo, transferencia pendiente/confirmada, permisos y tenant, motivo, concurrencia y carrera con cierre, reintentos/replay alterado/padre falso, historial intacto, cifras exactas, stock/costo, mirror con ventas posteriores y ACK canónico de cierre.

Playwright: diálogo accesible, foco inicial/Escape/retorno, motivo vacío bloqueado, anulación online, anulación deshabilitada offline, replay stale con recuperación local y recarga; regresiones de venta/offline/reportes. Capturas 375 y 1440 en `test-results/void-sale-owner-annulment--745b1-ror-and-responsive-evidence/` (resultados locales ignorados por git): `void-confirm-{375,1440}.png`, `void-result-{375,1440}.png`, `void-offline-375.png`.

Entorno: PostgreSQL `pos_piloto_test` y `pos_piloto_e2e`; Playwright permite `E2E_API_PORT=3101 E2E_WEB_PORT=5181` para convivir con dev. Sin borrar DB dev ni detener sus procesos.

## Progreso / memoria filesystem (project: nexora)

- Implementación y primera batería: API 119 verdes, shared 25 verdes; web 45 verdes tras corregir fixture sin turno; browser 6/6 verdes.
- Revisión visual: capturas de diálogo móvil y resultado desktop abiertas y verificadas. Se conserva jerarquía/tokenización existente y CTA visible en móvil.
- Ajustes finales: clave estable de compensación, semántica visible en Números/Reportes/Caja, prueba de carrera real con cierre y ACK canónico de cierre offline. Validación final registrada al finalizar el batch.
- Pendientes de producto: ajustes posteriores al cierre, devolución parcial, staging de ventas de más de 50 mutaciones; fuera del batch. Próximo batch recomendado: SKU/barcode.

No hay herramientas Engram disponibles en esta sesión; decisiones, hallazgos y cierre se persisten en este archivo versionado.

### Cierre de sesión — 2026-11-10

- **Goal:** entregar anulación total online auditable y probar gradualmente el batch.
- **Instructions:** sin build; tests secuenciales; autorización commit/push a origin main; no datos dev ni cambios de git config/attribution.
- **Discoveries:** LWW podía reactivar ticket/pago; refresh de variante omitía costo; paginar cola antes de agrupar partía ventas. Se protegieron los tres caminos. Un fixture nuevo calculaba caja sin abrir turno: se corrigió el fixture.
- **Accomplished:** comando transaccional/idempotente, auditoría, diario compensatorio, protección de replay/permisos/tenant/cierre, mirror local, semántica neta y UI accesible. Typecheck y lint verdes. Batería final secuencial: shared **25**, API **121**, web **45** = **191/191**; Playwright **6/6** en 3101/5181. `git diff --check` limpio. Capturas finales móvil y desktop abiertas y revisadas. No se ejecutó build.
- **Next Steps:** SKU/barcode. Staging de tickets muy grandes y ajustes tras cierre siguen pendientes explícitos.
- **Relevant Files:** `apps/api/src/db/void-sale.ts` (comando/auditoría), `db/sync-apply.ts` y `scope.ts` (freeze/locks/cierre), `apps/web/src/db/void-sale.ts` y `src/sync/*` (mirror/cola), `screens/Tickets.tsx` (confirmación), `packages/shared/src/{reports,arqueo,mutations}.ts` (semántica/ACK), tres archivos nuevos de pruebas y `playwright.config.ts` (puertos alternativos).
