# NEXORA — UI/UX responsive

## Brief

Cajeros, dueños y administradores de comercios colombianos operan ventas,
cobros, caja, inventario y cartera en COP, incluso sin conexión. La interfaz
prioriza lectura rápida, acciones contextuales y estados veraces de los datos.
Consola administra la plataforma, fuera del contexto operativo del comercio.

La referencia visual establecida es el prototipo NEXORA: índigo/slate,
Plus Jakarta Sans, JetBrains Mono, superficies claras y radios existentes.
No se incorpora una nueva paleta ni un tema oscuro.

## Fuente de verdad

- `apps/web/src/nexora.css`: identidad, tipografía, colores, materiales y movimiento.
- `apps/web/src/responsive.css`: reglas responsive vigentes; se importa al final
  para prevalecer sobre las composiciones históricas de `app.css`.
- `apps/web/src/components/navigation.ts`: destinos, etiquetas, agrupación y
  matriz única de visibilidad. `tier` es permiso; `group` es jerarquía visual.
- `apps/web/src/screens/consola.css`: composición independiente de plataforma,
  con los mismos límites responsive.

El prototipo y su JSON histórico externos son contexto, no dependencias del
checkout. Su navegación desplazable por debajo de 768px fue reemplazada por
el siguiente contrato:

| Ancho | Navegación |
| --- | --- |
| <640px | Hasta cuatro destinos directos + Más, solo iconos, targets >=44×44 |
| 640–1023px | Bottom nav sin scroll, iconos y etiquetas cortas |
| >=1024px | Sidebar de 256px, grupos Operación y Gestión |

La navegación inferior ocupa espacio real en el shell. El checkout móvil usa
`--checkout-height` y `--navigation-height` para su posición y reserva en el
scroller. Los avisos aparecen bajo el header, fuera de los controles inferiores.
Los títulos se truncan; conservan el texto completo en el DOM y en `title`.
Más usa un diálogo nativo con foco contenido, Escape y retorno al disparador;
su lista proviene exclusivamente de la matriz ya filtrada por rol/features.

## Inventario

- Login y recuperación; estados de arranque, bloqueo, acceso y preservación.
- POS: búsqueda/escaneo, categorías, grilla, orden, cobro, éxito y anulación.
- Caja: apertura, resumen, movimientos, conteo, cierre e historial.
- Tickets: filtros, tabla, comprobante, transferencia, cuenta y anulación.
- Catálogo: filtros, cards, producto/variantes, categorías y estado.
- Clientes/Fiados: cartera, alta/edición, detalle, inactivos, abono y recibo.
- Panel: períodos, KPI, atención, ranking y horas pico.
- Reportes: rango aplicado, ventas/top/stock, Excel y corte imprimible.
- Administración: resumen, cajas, empleados/roles y configuración.
- Consola: resumen, tiendas, alta y estados de conexión/acceso.

Compartidos: AppShell, navegación/cuenta/reloj, PaymentModal, ProductModal,
ClientModal, AbonoModal, CashMovementModal, ReceiptPreview, NotificationPopover,
CommandPalette, Toast y ProductIcon.

## Correcciones

- Navegación por rangos, jerarquía y nombres accesibles; Consola alineada.
- Header compacto, checkout separado del nav y toast fuera del cobro.
- Toolbar/categorías y cards resistentes a nombres, SKU y teléfonos largos.
- Orden desktop dimensionada por el contenedor disponible, con scroll interno.
- Controles táctiles y formularios móviles; safe areas de modales/footer.
- Cupo: se preserva el texto inválido y se rechaza explícitamente; nunca se
  transforma un decimal en otro importe eliminando caracteres.
- Métodos de pago como botones de selección con `aria-pressed`; Fiado y el
  mensaje de stock respetan los settings existentes del comercio.
- Consultas con carga/error/reintento separados de vacíos reales.
- Tablas con desplazamiento local, región nombrada, foco y contenido completo;
  ningún dato financiero se elimina para hacerlas entrar en móvil.

## Verificación

`e2e/ui-responsive.spec.ts` mide límites 639/640/1023/1024 y anchos
320/375/768/1440 con datos largos, última fila, targets, Más, teclado,
tablas y hit-testing del cobro. También verifica cupo decimal, settings y
fallos recuperables de consultas locales. `role-matrix.spec.ts` comprueba
los destinos de Más para el cajero; `batch7-consola.spec.ts` mide Consola.

Las suites existentes cubren cobros, Fiado/mixto opt-in, recibos, caja,
catálogo, empleados, preservación y operación offline. Ejecutar E2E con un
solo worker (configurado), sin builds:

```sh
pnpm typecheck
pnpm lint
pnpm --filter @pos/web exec vitest run --no-file-parallelism
E2E_API_PORT=3101 E2E_WEB_PORT=5181 pnpm e2e
```

Las capturas `ui-applied-*` y `batch7-*-responsive-boundary.png` se guardan
en el directorio temporal de evidencia de las pruebas. Son para revisión
visual manual; las pruebas inspeccionan DOM/geometría, nunca imágenes.
Teclado virtual, safe areas y tacto requieren la comprobación final en hardware.
