# NEXORA — modernización integral del prototipo

## Encargo y UI

- **Público:** cajeros y dueños de comercios colombianos en escritorio/tablet/teléfono con cortes de conexión.
- **Objetivo/oferta:** modernizar las **siete vistas** y todos los flujos visibles del prototipo entregado sin perder ventas, trazabilidad ni capacidad offline.
- **Vistas:** Venta/POS → cobro → recibo · Caja & Arqueo → movimiento/conteo/cierre · Tickets & Historial → recibo/anulación · Catálogo → crear/editar · Panel → períodos/alertas · Reportes → aplicar/exportar · Clientes & Fiados → alta/abono/detalle.
- **CTA por vista:** POS «Procesar Cobro» · Caja «Guardar Arqueo y Finalizar Turno» · Tickets «Ver/Anular» por fila · Catálogo «Nuevo Producto» · Panel sin CTA global (alertas navegan) · Reportes «Exportar a Excel» · Clientes «Nuevo Cliente Fiado» / «Registrar Abono».
- **Contenido real:** sesión/organización, catálogo, stock, pagos, turnos y saldos del tenant. Prohibido copiar como verdad los datos de muestra del HTML (Carlos Arango, NIT, dirección, importes, versión 2.4, métricas fijas, «Caja #01»).
- **Tono:** NEXORA operativo; importes COP enteros `es-CO`, fechas Bogotá.
- **Restricciones:** React/CSS/Lucide actuales, PGlite/Postgres, fuentes autoalojadas, sin CDN runtime, **sin build**, sin commits/pushes desde esta fase.

## Contrato y decisiones

- **Fuente de verdad de diseño:** `design-rules.json` (paleta índigo/slate, escala tipográfica, radios 12/16/24, spacing, glass, sombras) compilado a `apps/web/src/nexora.css`; `app.css` conserva reglas de componentes/pantallas y no recibe tokens nuevos (en empate de especificidad gana `nexora.css` por orden de import en `main.tsx`).
- **Referencia visual única:** el HTML del usuario (28 capturas `nexora-ref-*`). Tomar jerarquía, tipografía, colores, tablas, modales; evitar datos simulados, IVA mal calculado, recortes móviles y validaciones monetarias débiles.
- **Shell:** sidebar 256 / topbar 64; orden Venta · Caja · Tickets · Catálogo · Panel · Reportes · **Clientes & Fiados al final**; títulos del topbar = mapa `switchTab()` del prototipo; footer con iniciales/nombre/rol real + turno/base reales («Sin caja abierta» si no hay); reloj Bogotá con tick propio (sin consultar DB); campana con alertas DERIVADADAS (transferencias pendientes, stock bajo real, sync error, poison) y estado vacío «Sin alertas»; toasts tipados 3500ms con pausa y roles ARIA.
- **Cinco modales + movimiento (gramática común `<dialog>` nativo):** Cobro 512/r24 · Recibo 320/r12/mono · Producto 448/r24 · Cliente 448/r24 · Abono 384/r24 · Movimiento de caja 448/r24 (no existe en el HTML; misma gramática). Todos: nombre accesible, foco inicial/retorno al disparador, Escape (salvo envío en curso), fondo inerte, scroll interior `max-height: calc(100dvh - 32px)`, errores junto al campo, busy ref-síncrono contra doble click.
- **Checkout único modal (M5):** «Procesar Cobro» abre UN modal en desktop y móvil; F1/F2/Enter operan el mismo modal con un solo commit; **sin F3**; recibo solo después del commit durable; cancelar/error conservan el carrito; transfer queda **pendiente** hasta la confirmación owner online; crédito queda confirmado con el importe adeudado a la vista.
- **B1 IVA diferido:** sin fila fiscal en carrito/recibo, precios/totales intactos, sin afirmar IVA19% ni exención. El recibo NO inventa NIT/cajero/hash fiscal: ID = UUID real.
- **B2 gaveta (solo turnos nuevos):** `drawer_cash_v2 = base + efectivo + abonos efectivo + ingresos − retiros`, transferencias y abonos por transferencia aparte; versión explícita en turno Y cierre; `legacy_v1` y snapshots cerrados intactos, sin recalcular dinero histórico. Ver `FIADO.md`.
- **Sobreventa:** se conserva la política real aprobada (advertir y permitir); el bloqueo duro del HTML NO se copia.
- **Móvil (adaptación documentada):** el HTML a 375 tiene defecto reproducible (sidebar 615px, carrito encima del catálogo). La app usa nav horizontal scrollable <768, header compacto, carrito en barra inferior con resumen, `scrollWidth == width` sin overflow de documento. **No se copia el defecto; sí se conserva estética/tokens/contenido.**

## Sync y caché

- Modernización NO cambia el contrato de negocio: mismas colas, ACK, preservación y aislamiento (ver `PRESERVACION-LOCAL.md`, `SYNC-VENTAS-GRANDES.md`, `ANULACIONES.md`, `FIADO.md`).
- Datos nuevos de UI (iconos `icon_key`, base/versión de turno, movimientos, notas de cierre, clientes/abonos) viajan por las mismas mutaciones con campos **opcionales retrocompatibles**: web viejo contra API nueva y payloads legacy siguen parseando.
- Rehidratación incluye las tablas nuevas (clientes, abonos, movimientos, cierres, turnos históricos, `ticket_lines.unit_cost`); wipe protegido enumera 15 tablas.
- Offline: lecturas desde PGlite, indicador de staleness en vistas con datos de negocio; éxito local rotulado «(pendiente de sync)».

## Verificación y evidencia

- **Gate secuencial (DB compartida, nunca en paralelo):** `pnpm typecheck` → `pnpm lint` → `@pos/shared` → `@pos/web` → `@pos/api` → `E2E_API_PORT=3101 E2E_WEB_PORT=5181 pnpm e2e`. **Prohibido build** (AGENTS.md/SKU.md).
- **Evidencia de lotes:** M4 shell/alertas/fuentes · M5 POS/modal/recibo/tabla · M6 clientes/abono/catálogo · M7 períodos/XLSX/corte · M8 caja/versiones · **M9 matriz cross-view final** (7 vistas × 1440/375, 6 modales con Tab/Shift+Tab aislados, Escape + retorno de foco, viewport corto 520, `reduced-motion`, red externa bloqueada con `external == []`, fuentes locales con glifos `ñ/Ő`, datos largos, dinero inválido sin escritura, atajos que no cobran a través de paleta/dialog, recibo sin IVA/NIT/fake identity, void 409 sin mutar abonos).
- **Capturas:** `/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode/` — `nexora-ref-*` (28 referencias), `m4-*`, `m5-*`, `m6-*`, `m7-*`, `m8-*`, `m9-{1440,375}-view-*` + modales/detalle/estados.
- **Diferencias honestas vs prototipo:** sin fila de IVA (B1) · datos reales en vez de muestras (footer/campana/reportes) · recibo con Cerrar/Imprimir separados y toggle 58/80 · tarjetas/modales más altos por campos reales (límite, notas, variantes, auditoría de stock) · «Este Mes» es mes calendario Bogotá (no 30d renombrado) · ranking por ventas reales (no precio) · sin identidad fiscal inventada · adaptación móvil propia (no pixel-identidad con el HTML roto).
- **NO verificado aquí (no se afirma):** build de producción, service worker/fuentes precacheadas en artefacto desplegado (se confirma en 17.3), impresora física58/80mm, teléfono/teclado iOS/safe-areas en hardware.

## Despliegue

Ver checklist API→web y rollback en `FIADO.md` (ejecución = tarea **17.3, pendiente**; sin entorno autorizado en esta fase).

> **Estado:** M1–M9 implementados y verificados en local; **despliegue pendiente (17.3)**; IVA (15.1) diferido.
