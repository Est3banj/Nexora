# NEXORA — SKU / código por variante

## Encargo, decisiones y reglas UI (project: nexora)

- Público: cajero y dueño del comercio. Objetivo: identificar la presentación correcta y agregarla rápidamente, incluso offline.
- Oferta/contenido: un SKU o código de barras opcional por variante; cerveza 330 y 600 tienen identificadores independientes. Texto real ingresado por el comercio.
- Vistas/CTA: Catálogo → crear/guardar código; Venta → agregar por código. El cobro continúa separado y explícito.
- Tono operativo, mensajes accesibles; stack actual, mobile-first, sin build, una terminal por comercio.
- Referencia y reglas: catálogo/venta actuales y `apps/web/src/app.css` son la fuente de tokens/componentes/responsive. Se conserva la estética existente; no hay nueva dirección visual ni animación al escanear.
- Identificador string, trim exterior, vacío → null; sensible a mayúsculas, ceros iniciales intactos, máximo 120 caracteres. Único dentro del tenant, incluso en variantes inactivas. Nombre y código se pueden buscar parcialmente sin distinguir mayúsculas; scanner requiere coincidencia exacta.
- Migración aditiva en el mismo datadir pos_v3; no se descartan colas. Envelopes legacy que omiten código conservan el actual.

## Plan de verificación

- [x] Persistencia servidor/local, unicidad tenant y rechazo claro, legacy replay, rehydrate, conservación metadata.
- [x] Campo explícito scanner USB teclado + Enter; una unidad, sin cobro; desconocido sin agregar.
- [x] Offline → venta → reconnect idempotente; screenshots 375/1440 revisadas.
- [x] Typecheck/lint/tests secuenciales y revisión diff/status/log.

## Persistencia y sincronización

- `VARIANT_CODE_MIGRATION_SQL` es DDL aditivo compartido: columna nullable, índice único `(tenant_id, code)` y CHECK de formato normalizado. El servidor lo ejecuta al arrancar (`migrateCatalog`); el cliente lo ejecuta al abrir **el mismo `pos_v3`**. No requiere `drizzle push` en una DB existente. Reiniciar la API y recargar la app activa la migración.
- Los formularios crean/actualizan la variante y su envelope en una transacción local. Foto/categoría del producto y costo/código de la variante sobreviven ediciones, ajustes y ventas; los campos opcionales omitidos por clientes legacy no limpian esos valores.
- Referencias categoría/producto se validan dentro del tenant. La categoría sigue siendo del producto; el identificador, de la variante.
- Duplicado local: rollback + mensaje «El código ya pertenece a otra variante de este comercio». API: HTTP 409 `duplicate_code`. Sync: rechazo determinista `duplicate_code`, como máximo tres intentos antes de aislar la entrada; no hay retry automático infinito. Editar el código vuelve a encolar la versión corregida. Resolver el código en Catálogo antes de descartar errores.
- Los estados in-flight/ACK/error de la cola comparan **payload y client_ts enviados**: una respuesta vieja no puede tragarse una edición hecha durante el request. Hay prueba real con fetch bloqueado, edición concurrente y segundo envío.
- Rehydrate conserva el comportamiento insert-only existente: carga caché nueva sin encolar ni pisar cambios locales; no es una reconciliación multidispositivo.
- Se conserva la política actual de push: catálogo queda pendiente hasta push manual, venta o reconexión; la carga de catálogo por sí sola actualiza el badge.

## Uso y límites

En Catálogo asigná el código a cada presentación. En Venta enfocá «SKU / código de barras», escaneá con un lector USB configurado como teclado con sufijo Enter, o escribí el código y presioná Enter/Agregar. No hay captura por cámara ni escucha global del teclado. El catálogo debe estar disponible en la caché local. Un código desconocido no crea productos ni inicia pagos.

Un lector que manda letras debe usar la distribución de teclado correcta. El match del scanner distingue mayúsculas/minúsculas; la búsqueda de catálogo/venta no. SKU y barcode comparten **un único identificador** en este slice: no hay aliases ni dos códigos por variante.

## Verificación real — 2026-11-10

| Contrato | Evidencia ejecutada |
| --- | --- |
| Crear/editar/limpiar, ceros iniciales, duplicado tenant vs otro tenant, rechazo numérico | `apps/api/test/variant-code.test.ts` |
| Legacy conserva código/costo/foto/categoría; referencias ajenas rechazadas | `apps/api/test/variant-code.test.ts` |
| Migración repetida sobre tabla PostgreSQL pre-código y cache PGlite pre-código con venta/cola pendiente | tests `variant-code` API y web |
| Metadata y código atraviesan edit/ajuste/venta; rehydrate idempotente | `apps/web/test/variant-code.test.ts` |
| Rechazo duplicado termina retries; editar recupera entrada; ACK anterior conserva edición nueva | `apps/web/test/variant-code.test.ts` |
| Buscar nombre/código, alta de variante adicional y error duplicado, guardar y recargar | `e2e/variant-code.spec.ts` a 375/1440 |
| Enter en búsqueda normal no agrega; scanner exacto agrega solo una unidad; segundo Enter vacío no agrega/cobra; desconocido no agrega | `e2e/variant-code.spec.ts` a 375/1440 |
| Scanner/venta offline, reconexión, repush duplicate, una línea/pago/ticket y stock/costo/código correctos | `e2e/variant-code.spec.ts` a 375/1440 |

- `pnpm lint`: verde. `pnpm typecheck`: verde.
- Suites ejecutadas secuencialmente: shared **25/25**, API **125/125**, web **50/50** = **200/200**.
- `E2E_API_PORT=3101 E2E_WEB_PORT=5181 pnpm e2e`: **8/8**, un worker y DB `pos_piloto_e2e` dedicada. API usa `pos_piloto_test`. No se ejecutó build ni se modificó DB dev.
- Primer E2E nuevo esperaba autosync de catálogo: se corrigió el test para usar el push explícito existente. Un fixture LWW huérfano se corrigió creando el producto padre; la validación de referencias se mantuvo.
- Capturas locales ignoradas por git: `test-results/variant-code-variant-codes-a7d70-ne-sale-and-replay-at-375px/` y `test-results/variant-code-variant-codes-fb3cc-e-sale-and-replay-at-1440px/`, con `catalog-code-{width}.png`, `scanner-unknown-{width}.png`, `scanner-added-{width}.png`. Se abrieron y revisaron ambas anchuras; sin desborde horizontal, foco visible y cobro separado. Son pruebas de navegador emulado, no de teléfono/lector físico.

## Cierre / memoria filesystem (project: nexora)

- **Goal:** completar el slice mínimo SKU/código por variante, búsqueda y scanner teclado offline-first.
- **Instructions:** sin build, suites secuenciales, solo migraciones aditivas, sin git config/attribution, commit/push autorizados a origin main.
- **Discoveries:** datadir actual `pos_v3` permite migración in-place; catálogo no autopush; un ACK podía marcar una edición posterior como sincronizada. Se protegieron estados de cola por versión enviada y se probó la carrera.
- **Accomplished:** contratos Zod, DDL Drizzle/Postgres/PGlite, repo/rutas/sync/rehydrate/local, UI crear/editar/códigos adicionales, búsqueda y scanner explícito. 200 tests + 8 E2E verdes; capturas verificadas; guía y progreso persistidos aquí.
- **Next Steps (priorizado):** probar con lector USB físico y teléfono real (distribución teclado, sufijo Enter, foco y teclado móvil). Luego retomar staging para tickets que exceden 50 mutaciones. Continúa el límite de una terminal por tenant; no implica preparación para producción.
- **Relevant Files:** `packages/shared/src/{catalog,mutations,local-schema}.ts`; `apps/api/src/db/{schema,scope,sync-apply,migrate-catalog}.ts`; `apps/web/src/db/local.ts`, `src/sync/{queue,rehydrate}.ts`, `src/screens/{Catalog,Sale}.tsx`; tests `variant-code` API/web/E2E.

Engram no está disponible; este archivo registra decisiones, progreso y cierre de sesión.
