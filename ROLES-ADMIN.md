# NEXORA — roles admin: matriz de roles, permisos y superficies admin

> Cambio `roles-admin`. Este documento nace en el **Batch 1** (fix H1 + tier
> foundation + nota de rollout). Las notas de operación (roles Cajero y
> Administrador, códigos de anulación, toggles de settings) y el flip de abonos
> se agregan en el Batch 8 (tarea 8.8).

## Qué cambia (Batch 1 — fundación)

- `Role` del contexto de sesión pasa a `owner | admin | member`
  (`apps/api/src/auth/ctx.ts`), con el helper de tier `isDueño(role)` = `owner`
  o `admin`. `RequestCtx.role` sigue pudiendo ser `null` (usuario sin
  membresía o rol desconocido → sin tenant → 403 `no_active_tenant`, sin
  cambios).
- **Fix H1 (`apps/api/src/auth/plugin.ts`, mapa de roles):** better-auth 1.7.19
  devuelve roles de organización `admin|member|owner`
  (`crud-members.d.mts:420`; `defaultRoles` en `access/statement.mjs:71-74`).
  El mapa viejo (`owner|member`, resto `null`) convertía `admin` en `null` y,
  como el `tenantId` sólo se conserva cuando hay rol, **todo member con
  `role='admin'` quedaba bloqueado**: 403 `no_active_tenant` en cada ruta de
  negocio. Ahora `admin` resuelve rol **y** tenant.
- Roles fuera de los tres siguen fallando cerrados (sin tenant, sin datos).
- Existe desde ya el gate de tier para endpoints **nuevos**:
  `app.requireDueño` → 403 `{ error: "forbidden", detail: "dueño_only" }`
  (`apps/api/src/auth/plugin.ts`, se encadena después de `requireAuth`).
  **Los endpoints existentes NO cambian en este lote**: anulación
  (`sales.ts` → `owner_only`) y confirmación de transferencia (`payments.ts` →
  `detail: "owner_only"`) conservan su cuerpo exacto hasta el Batch 2.
- Regresión cubierta en `apps/api/test/auth.test.ts` — caso
  "admin member resolves role admin WITH tenantId (bug regression)":
  `getActiveMemberRole` devuelve `admin`, ruta de negocio 200 y la escritura
  aterriza en el tenant del admin.

## Notas de versión / rollout

### 1. Blast radius del fix admin — es intencional

Cualquier miembro con `role='admin'` pasa de un día para el otro de
**bloqueo total (403 `no_active_tenant`) a poder completo de nivel Dueño**
(misma superficie que el owner: catálogo, reportes, transferencias,
anulación, ajustes de stock). Es intencional: la matriz de este cambio define
**nivel Dueño = `owner` + `admin`**. No es un regalo accidental — es el
modelo.

### 2. Auditoría pre-deploy — obligatoria

Antes de desplegar, listar quién tiene `role='admin'` hoy:

```sql
SELECT u.email, m."organizationId" FROM member m JOIN "user" u ON u.id = m."userId" WHERE m.role = 'admin';
```

Revisar cada fila: si el rol se otorgó casualmente (prueba, favor, error),
**degradar esas filas a `member` antes del deploy**. Después del deploy, cada
fila restante tendrá poder Dueño real.

### 3. Mismo release — poder coherente, no parcial

Todos los gates tier de este cambio (catálogo, reportes, transferencia,
anulación, sync, settings, panel de administración) caen en el **mismo
release** que el fix de contexto: el rol `admin` queda con poder Dueño
completo y los límites del resto de la matriz aplican juntos. No publicar el
fix suelto a la mitad del cambio — poder a medias = comportamiento incoherente.

### 4. Orden de deploy y rollback

1. **API primero, web después** (patrón fiado H4 — ver `FIADO.md`
   §Despliegue).
2. Verificar con un usuario `admin` real que entra y ve datos de negocio.
3. **Rollback: web primero**; la API sólo si un gate falla (el fix de contexto
   es aditivo: el web viejo sigue funcionando contra la API nueva).

### 5. Alcance de esta nota

El flip de abonos (member pasa a registrar abonos — supersede fiado decisión
#6) y las notas de operación están en **Batch 8 — Operación**, más abajo.

---

## Batch 8 — Operación (notas de operador)

### Roles y personal (Administración ▸ Empleados)

- **Cajero (`member`)**: vende, cobra, registra abonos, consulta catálogo
  (solo lectura) y tickets. Ve 5 pestañas.
- **Administrador (`admin`)**: nivel Dueño completo (8 pestañas, mismos
  gates server-side que el dueño) **salvo la gestión de personal**:
  - El **Administrador crea y gestiona SOLO Cajeros** (`role: member`):
    crear cajero, quitar acceso de cajeros. **No** puede crear/promover/
    demotear/quitar administradores (403 `owner_only` en la API).
  - El **Dueño (`owner`)** hace todo lo anterior **más** crear, promover,
    degradar y quitar administradores.
  - Las filas **Dueño son read-only** para todos (`owner_readonly`); no hay
    transferencia de owner, ni edición/borrado de owner por UI ni API.
- **Alta sin email provider**: el panel crea la cuenta localmente con
  `signUpEmail` + `addMember`; la **contraseña inicial se genera y se
  muestra una sola vez** (no se envía ningún email). Sin flujo de
  invitaciones por enlace.
- **Rutas raw de better-auth bloqueadas** en el proxy `/api/auth/*`
  (`apps/api/src/app.ts`): `add-member`, `update-member-role`,
  `remove-member`, `invite-member`, `accept/reject/cancel-invitation`,
  `leave`, `delete` (borrado de organización) → 403
  `{ error: "use_admin_users_api" }`. Todo cambio de membresía pasa por
  `/api/admin/*` (BFF con lookup de tenant y política owner/admin de arriba).
  Quedan abiertos lo legítimo: sign-in/sign-up, session, `set-active`,
  lecturas de rol/miembros, y el provisioning in-process del founder.
  Regresión: `apps/api/test/admin-users.test.ts` (bypass explícito por
  endpoint, con y sin sesión).

### Matriz de menú por rol

| Rol | Pestañas | Consola (cuenta, fuera del shell) |
|---|---|---|
| `member` (Cajero) / rol sin verificar | 5: Venta, Caja & Arqueo, Tickets, Catálogo (solo lectura), Clientes & Fiados | no |
| `owner` / `admin` | 8: las 5 + Panel, Reportes, Administración | sólo si el usuario tiene el flag `platformAdmin` |

El servidor es la autoridad: cualquier deep-link o acción rechazada por rol
responde 403 en la API aunque el hint client-side diga lo contrario.

### Anulaciones con código (Administración ▸ Configuración)

1. Activar **“Exigir código de anulación”** (`require_annul_code`) y guardar.
   - **OFF (default)**: anula sólo dueño/administrador, sin código —
     comportamiento histórico.
   - **ON**: **nadie** anula sin el código vigente (ni el dueño); **cualquier
     rol verificado** (Cajero incluido) anula **con** el código.
2. **Generar código** (o **Rotar**): 8 caracteres, se muestra **una sola
   vez**, TTL **15 minutos**, HMAC guardado en el server. Rotar mata al
   anterior **al instante**.
3. **Si vence**: pedir un código nuevo desde el panel (no hay gracia ni
   recordatorio push). El diálogo de anulación muestra el error y el campo
   de código.
4. El código **nunca** se guarda en localStorage ni viaja por sync; se
   valida exclusivamente en `POST /api/sales/tickets/:id/void`
   (online-only, como la anulación). Ver `ANULACIONES.md`.

### Toggles de operación (Configuración)

| Toggle | Default | Efecto |
|---|---|---|
| `enable_fiado` | **ON** (= comportamiento actual) | OFF: oculta pestaña Crédito y el server rechaza pagos `credit` y abonos en sync |
| `allow_negative_stock` | **ON** (= comportamiento actual: oversell permitido) | OFF: el POS local y el server rechazan ventas que dejarían stock < 0 |
| `require_annul_code` | **OFF** (= comportamiento actual) | ver arriba |

Fila ausente de `tenant_settings` = defaults → tenants existentes sin cambios
el día del deploy.

### Sync de member — quién es la autoridad (boundary de dinero)

- `ref_ticket_id` es **una pista de agrupación, NUNCA autoridad**: el server
  resuelve el rol de sesión y lo reaplica en `applyMutationGroups` **y** en
  `finalizeSale` (rechequeo al finalizar un staging).
- **Variant en venta de member**: sólo puede referenciar una variante
  **existente en el tenant** y viaja como **refresh hint** — la respuesta
  hace ACK sin tocar precio/costo/nombre/código/stock del catálogo (un
  snapshot offline viejo **no** pisa precios del server). Crear/editar
  catálogo es Dueño-tier (REST 403 + rechazo per-item en sync).
- **stockdiary de member**: aceptado sólo con evidencia de venta **persistida
  en el tenant** (ticket + líneas existentes), `reason='sale'`, deltas
  negativos que no superan las cantidades de las líneas; replay con contenido
  alterado → rechazado. Ajustes manuales/`initial` sin venta → rechazados.
- Entregas legacy parciales (ticket/líneas primero, movimiento después) y
  reintentos siguen funcionando; no se exige el agregado completo por
  paquete. Precio de la línea de venta = precio histórico de ESA venta
  (negocio del ticket), no autoridad de catálogo.
- Evidencia: `apps/api/test/member-sync-authority.test.ts`.

### Datos: rehydrate y confidencialidad (boundary honesto)

- `GET /api/rehydrate` es **any-auth** por diseño: el POS offline necesita
  reconstruir su cache **incluso para el Cajero** — eso incluye **datos
  financieros del tenant** (ventas, pagos, saldos de clientes) en el
  dispositivo del cajero.
- **Ocultar pestañas/KPIs en la UI NO es confidencialidad**: el cajero con
  dispositivo en mano tiene esos datos en su base local. La matriz de roles
  gobierna *superficie y acciones*, no el alcance de los datos del tenant.
  Las **APIs** de reportes financieros (dashboard/sales-by-day/top-products)
  sí están gated a nivel Dueño (403) para el *flujo* de la app; el rehydrate
  queda abierto a propósito (bricking del offline sería peor).
- Settings (`GET /api/settings`) es any-role y **hash-free**; el código de
  anulación jamás sale del server.

### Rollout (continúa §Notas de versión / rollout)

- **Supersession del flip de abonos**: fiado decisión #6 (owner-only
  `credit_abono`) → **roles-admin decisión #1** (cualquier rol verificado).
  Los tests se flipearon deliberadamente en el mismo cambio
  (`credit-sync.test.ts`, `e2e/fiado.spec.ts` M6).
- Orden de deploy **API → web**, rollback **web primero** (§4).
- Auditoría pre-deploy de filas `role='admin'` (§2) sigue obligatoria.
- **No** se resuelven en este cambio: cap global de paquetes de sync ni
  colisiones de `ticket_no` (ver `SYNC-VENTAS-GRANDES.md` — fuera de
  alcance, sin cambios aquí).

### Fuera de alcance

IVA (sólo storage, sin matemática ni renglón fiscal), proveedores &
compras, PINs de staff, billing/planes/releases/feature-flags/infra/logs,
multi-terminal, roles custom, transfer de owner, invitaciones por email.
