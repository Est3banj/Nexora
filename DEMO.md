# Guion de demostración — NEXORA

Duración estimada: **25–30 min**. Cuenta con4 cuentas reales (guardá las contraseñas en tu gestor):

| Perfil | Correo | Qué mostrar |
|---|---|---|
| **Dueño** | `owner-prueba-aa404f9765a1@nexora.test` | Todo (8 destinos) |
| **Administrador** | `admin-prueba-aa404f9765a1@nexora.test` | Mismos 8 destinos, gestiona Cajeros |
| **Cajero** | `member-prueba-aa404f9765a1@nexora.test` | Solo5 destinos (sin Panel/Reportes/Administración) |
| **Super Admin** | `superadmin-privado-aa404f9765a1@nexora.test` | Consola del software (sin tienda activa) |

Datos ya preparados en **Tienda Demo**:8 productos activos · clientes **Marcela Benítez** ($19.500 deuda), **Rodrigo Silva** ($2.000), **Andrea Montero** (Al Día) ·2 ventas de hoy en efectivo · turno abierto con **base $100.000** (gaveta v2).

## Arranque

```bash
cd ~/pos-piloto && pnpm dev
# Abrir http://localhost:5173
```

## Guion

###1. Venta en3 toques (60s)
1. **Venta** → clic en un producto → **Cobrar**.
2. **Exacto** → **Cobrar en efectivo** → recibo con **Imprimir**.
3. *Qué decir:* "El cobro se guarda en el celular primero y sincroniza después — si se va el internet, la venta no se pierde."
4. **Scanner real**: escribí un código en el campo SKU (o usá el lector) + Enter → agrega sin cobrar.

###2. Transferencia pendiente (40s)
Otra venta → **Transferencia** → Registrar → en **Tickets** aparece *"Transf. pend."* → abrir → **Confirmar transferencia** (solo el dueño). *Qué decir:* "Sincronizar no es cobrar: el banco lo confirma el dueño."

###3. Fiado y abono (2–3 min) — el corazón comercial
1. **Clientes & Fiados** → mostrar tarjetas: Marcela **Con Deuda $19.500**, Andrea **Al Día**.
2. Venta → producto → Cobro → pestaña **Fiado** → elegir Marcela → **Confirmar y Generar Ticket**.
3. De vuelta en Clientes → **Registrar Abono** → monto → recibo del abono.
4. *Qué decir:* "Su cuaderno de fiado, con saldo que nunca se pierde y sin sumar dos veces las ventas."

###4. Caja (2 min)
1. **Caja & Arqueo**: turno activo con **base $100.000**, resumen y **Conteo Físico** (campo vacío — nunca se autocompleta).
2. **+ Ingreso / Retiro** → registrar un gasto menor → el esperado se ajusta.
3. **Cerrar Turno**: contás el efectivo, ves la diferencia en vivo, agregás nota y guardás. El cierre queda como historial inmutable.
4. *Qué decir:* "La transferencia está aparte; esto cuenta lo que hay en la gaveta."

###5. Tickets y anulación (2 min)
Abrir un ticket → **Imprimir** → **Anular venta completa** con motivo. Si decidís activar el código: *Administración → Configuración → exigir código → generar* (dura15 min, se muestra una vez) y anulás con él.

###6. Catálogo: permisos (1 min)
Con el **Dueño**: Catálogo → crear/editar producto. Cambiá a la ventana del **Cajero** (otro perfil del navegador): el Catálogo es **solo lectura** — sin botones de edición. *Qué decir:* "El cajero consulta precios y stock, no toca costos."

###7. Panel y Reportes (2 min)
- **Panel**: ingresos vs. período anterior, crédito y abonos por separado, horas pico, alertas de stock.
- **Reportes**: rango → **Aplicar Filtro** → **Exportar a Excel** (archivo real) y **Corte de caja** (imprimir/papel o PDF).

###8. Roles en pantalla (1 min)
Ventana del **Cajero**:5 menús, sin Panel ni Reportes (deep-link bloqueado con mensaje). Ventana del **Dueño**:8. Etiqueta "Cajero" en vez de "Miembro".

###9. Offline — el remate (1 min)
**Modo avión** → vender → el ticket se guarda → reconectás → sincroniza solo. *Qué decir:* "En su local con internet malo, esto funciona igual."

###10. (Opcional) Super Admin
`superadmin-privado-…` → **Consola** → resumen global + tiendas (solo datos de estado, nunca ventas de los comercios).

## Límites para no prometer en la demo

- **IVA**: guardado como configuración, **no se calcula** todavía (diferido).
- **Varios dispositivos vendiendo a la vez en el mismo comercio**: aún no (numeración de tickets y cupo de crédito locales). Piloto = **un dispositivo vendedor por tienda**.
- **Proveedores, planes, PINs**: fuera del alcance actual.

## Si algo falla

- `pnpm dev` caído → relanzar. Logs: `/tmp/pos-dev.log`.
- Pantalla rara → recargar (la cola de sync sobrevive).
- Para reiniciar datos de demo → `psql -d pos_piloto` (no toques `pos_piloto_e2e`, es de tests).
