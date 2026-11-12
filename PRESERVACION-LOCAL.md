# NEXORA — preservación de trabajo local en logout/upgrade

## Encargo y criterio de UI (project: nexora)

- **Público:** dueños y cajeros del POS, incluido trabajo offline en teléfono.
- **Objetivo/oferta:** salir o actualizar sin perder ventas, ediciones ni snapshots que el servidor aún no reconoció.
- **Contenido real:** cantidad de registros/snapshots sin ACK, último error de cola y pasos de recuperación en español.
- **Tono:** directo, sin afirmar sincronización cuando falta confirmación.
- **Vistas:** caja → busy → salida/upgrade completo, o blocked → retry / reautenticación del mismo comercio.
- **CTA principal:** «Reintentar sincronizar» en blocked; «Ingresar» en recuperación.
- **Restricciones:** React/PGlite existente, migración aditiva en `pos_v3`, sin build, sin cambiar checkout, 375/1440 px, teclado/focus-visible y mensajes persistentes.
- **Referencias de continuidad:** `screens/Login.tsx` y notices de `App.tsx`: reutilizar componentes, tokens y voz; evitar CTA que descarte datos. No se está rediseñando la marca.
- **Fuente visual:** `src/app.css`: system-ui 16px/1.45, título 24px, surface `#fff`, primary `#3d7dff`, texto `#16181d`, espacio 12/24px, radio 12px, controles 48px. Tarjeta de transición max 428px; sin movimiento de entrada. Estados busy/disabled, blocked/alert, retry y recuperación conservan los estilos existentes.

## Contrato de preservación

La DB local es evidencia de negocio hasta ACK. `unresolvedWork` suma **todos** los estados distintos de `synced` de **todos** los tenants más **todos** los snapshots `sync_sale_outbox`. El conteo puede incluir una fila y su snapshot: representa trabajo protegido, no cantidad de ventas.

`safeTransition`: single-flight por DB → sello durable → detach/espera del drain anterior → flush → inspección real → finalizar. Un error deja la base sellada y una pantalla con retry y reautenticación. El sello bloquea transacciones de negocio y enqueue de handlers viejos; los ACK y mirrors canónicos del drain pueden terminar. `clearLocalBusinessData` vuelve a verificar dentro de la misma transacción que borra, incluye categorías/outbox y deja las escrituras selladas. No basta con badge cero, `navigator.onLine` o éxito HTTP sin ACK válido de las versiones enviadas.

**Lista de tablas protegidas (`BUSINESS_TABLES`, `preservation.ts:12`):** 15 tablas — `sync_sale_outbox`, `sync_log`, `cash_movements`, `stockdiary`, `stockcurrent`, `closedcash`, `credit_abonos`, `payments`, `ticket_lines`, `tickets`, `customers`, `shifts`, `product_variants`, `products`, `categories`. La lista es la fuente de verdad del wipe (`clearLocalBusinessData`) y de `claimLocal`; el test `preservation.test.ts` la itera, así que cada tabla nueva se auto-cubre. **Falta agregar una tabla aquí = fuga de datos de negocio entre tenants en un dispositivo compartido** (motivo por el que `customers`/`credit_abonos` entraron en M1 y `cash_movements` en M3). El aislamiento server-side se prueba aparte en `apps/api/test/isolation.test.ts` (sweep de tablas de negocio + rehydrate, ampliado en M1 con `customers`/`credit_abonos` y en M3 con `cash_movements`).

Logout: solo después de confirmar cola/outbox se pide signOut; si auth falla no se limpia. Si limpieza falla, rollback conserva la DB; la sesión puede ya estar cerrada y se ofrece recuperar ingresando de nuevo. No hay atomicidad distribuida entre cookie y PGlite: el orden prioriza conservar datos y el sello/guard de tenant cubre el intervalo.

Upgrade: verificación también en `switchToCurrentDatadir`. Abrir/migrar/rehidratar candidato ANTES de cerrar el viejo y cambiar puntero. Un error de apertura/hidratación conserva handle y versión previos. El datadir anterior nunca se elimina. Sin «Continuar sin sincronizar». Cambios corrientes son aditivos y no requieren bump.

Poison: se reemplaza descarte por retry explícito que conserva UUID/payload. Un snapshot determinísticamente rechazado también se conserva; no se borra para liberar una salida. Errores de negocio requieren corregir la causa/revisión, no borrar la venta.

## Tenant y recuperación

- `local_vault` persiste owner + sello; una sesión sin tenant no habilita caja/sync. Recuperación explícita muestra login incluso si la cookie vieja sigue presente. No depende de que signOut funcione para salir de la UI de negocio.
- Pendientes ajenos bloquean adopción por otro comercio antes de renderizar datos o iniciar sync. Datos ya reconocidos de otro tenant se limpian en transacción al adoptar. Instalaciones legacy se revisan por filas scoped antes de asignar owner.
- Cada fetch de negocio nuevo manda `x-nexora-tenant` como **precondición**, nunca autoridad. API resuelve tenant desde sesión/membresía y responde 409 si difiere. Cubre legacy mutations, staged parts/finalize, rehydrate, void, pagos y turnos.
- Nombre del comercio y timestamp de sync usan claves por tenant; no se reutilizan claves legacy globales. Se limpian toast/tab/estado sync al cambiar sesión.
- Sello lógico, **no cifrado del dispositivo**. No evita inspección de IndexedDB por alguien con acceso al perfil del navegador. Usar el mismo comercio para recuperar; selección explícita de organizaciones múltiples queda pendiente.

## Evidencia / progreso

- Baseline limpio `main == origin/main`, `99724bf`; sin AGENTS anidados ni registro `.atl/skill-registry.md`. Skills apply, emil-design-eng y mobile-native. No Task/Engram disponibles; memoria en este archivo.
- Lock: inspeccionado `f6af175` y baseline actual; ambos usan `nexora/single-tab`. No se cambió el nombre ni se reabre una base tras error de migración; el wrapper cierra el handle fallido y libera lock. No se afirma resuelto ningún bug de screenshot previo.
- Web inicial: **66/72**, seis fallos de fixtures: offline no restaurado al retry (4), timestamp requerido de hidratación (1), test pre-code sin migración del vault (1). Corrección y repetición dirigida `pnpm --filter @pos/web exec vitest run test/preservation.test.ts test/upgrade-preservation.test.ts test/variant-code.test.ts`: **20/20**. No se afirma un run final completo verde.
- API `pnpm --filter @pos/api test`: **147/147**. Incluye precondición tenant en legacy/staging/rehydrate y sesión real.
- Verificación de navegador y checks finales: en progreso.

## Límites / siguiente prioridad

- No hay exportación ni resolución automática de poison. No se permite perder evidencia para resolverlo. Pendientes de varios tenants legacy necesitan recuperar cada comercio; la app no proporciona todavía selector de recuperación múltiple.
- Las solicitudes tienen timeout; un error de sesión no habilita el borrado. Offline reload en E2E requiere shell Vite accesible, conservando `navigator.onLine=false` y bloqueo de requests sync.
- Después: costos históricos por línea y exactitud dashboard. Sin costo conocido no presentar 100% de margen; diferenciar confirmado/pending de forma congruente. Auditar referencias tenant del handler legacy (la precondición protege sesión equivocada, no sustituye guards FK por tenant).

## Memoria de sesión

**Goal:** slice completo de preservación logout/upgrade, tests, commit/push autorizados.

**Instructions:** apply_patch, no build/config/attribution; suites secuenciales; puertos 3101/5181 y DB e2e dedicada; respetar datos/procesos del usuario.

**Discoveries:** wipe original era best-effort incluso offline; discard eliminaba sync_log; outbox rechazado podía borrarse; singleton sync sobrevivía sesión. ACK remoto y versión/payload local son condiciones distintas. Abrir candidato después de cerrar viejo deja un handle inutilizable si falla hidratación.

**Accomplished:** vault aditivo/sello, chequeo transaccional, transición single-flight, guard server por tenant, retry sin descarte, datadir candidato preparado antes de cerrar viejo, pruebas descritas.

**Next Steps:** completar navegador/revisión, checks y entrega; luego costo histórico/dashboard y refs legacy.

**Relevant Files:** `apps/web/src/db/{preservation,local,pglite,instance}.ts`, `sync/{safe-transition,queue,scoped-fetch,sale-upload,rehydrate,store}.ts`, `App.tsx`, `screens/Login.tsx`, `apps/api/src/auth/plugin.ts`; tests preservation/upgrade-preservation/tenant-precondition.
