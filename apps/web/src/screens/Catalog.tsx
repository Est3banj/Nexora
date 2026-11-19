import { useCallback, useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { Plus, Search, Settings2, SquarePen } from "lucide-react";
import { catalogError, listCategories, listProducts, updateLocalProduct, type LocalCategory, type LocalProduct } from "../db/local";
import { CategoryModal } from "../components/CategoryModal";
import { ProductIcon } from "../components/ProductIcon";
import { ProductModal } from "../components/ProductModal";
import { isDueñoHint, type RoleHint } from "../components/navigation";

const cop = (n: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
type Props = { db: PGlite; tenantId: string; role: RoleHint; refreshToken: number; showToast: (msg: string) => void; onMutated: () => void; pendingVariantId?: string | null; onPendingVariantUsed?: () => void };

export function Catalog({ db, tenantId, role, refreshToken, showToast, onMutated, pendingVariantId, onPendingVariantUsed }: Props) {
  /* roles-admin 5.5 / menu-visibility §Catálogo read-only for member:
   * browse/search/stock stay for every role, but create/edit/deactivate/
   * category affordances render ONLY for the Dueño tier. `null` (unverified)
   * is NOT dueño → hidden: unverified = no writes (server gates re-check
   * anyway — this is a hint, never authority). */
  const canWrite = isDueñoHint(role);
  const [products, setProducts] = useState<LocalProduct[]>([]);
  const [categories, setCategories] = useState<LocalCategory[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [managingCategories, setManagingCategories] = useState(false);
  const [editing, setEditing] = useState<LocalProduct | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, cats] = await Promise.all([listProducts(db, tenantId), listCategories(db, tenantId)]);
      setProducts(rows); setCategories(cats); setError(null);
    } catch (err) { setError(catalogError(err)); }
    finally { setLoading(false); }
  }, [db, tenantId]);
  useEffect(() => { void refresh(); }, [refresh, refreshToken]);
  useEffect(() => {
    if (!pendingVariantId) return;
    const product = products.find(p => p.variants.some(v => v.id === pendingVariantId));
    if (product) {
      // The notification hand-off opens the EDIT form — a write surface, so
      // it honours the same read-only gate. Always consume the pending id
      // (otherwise it would re-fire on every product refresh).
      if (canWrite) { setEditing(product); setOpen(true); }
      onPendingVariantUsed?.();
    }
  }, [products, pendingVariantId, onPendingVariantUsed, canWrite]);
  async function mutate(fn: () => Promise<unknown>, message: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await fn(); await refresh(); onMutated(); showToast(message); }
    catch (err) { setError(catalogError(err)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const q = search.trim().toLocaleLowerCase("es");
  const visible = products.filter(p => (category === "all" || (p.category_id ?? "") === category) && (!q || p.name.toLocaleLowerCase("es").includes(q) || p.variants.some(v => `${v.name} ${v.code ?? ""}`.toLocaleLowerCase("es").includes(q))));
  return <section className="screen catalog catalog-modern" aria-label="Catálogo">
    <div className="catalog-controls">
      <div className="catalog-filters"><div className="catalog-search-wrap"><Search size={16} aria-hidden="true" /><input type="search" data-testid="catalog-search" aria-label="Buscar en catálogo" placeholder="Buscar producto o SKU…" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="catalog-category-group"><select aria-label="Filtrar categoría" data-testid="catalog-category-filter" value={category} onChange={e => setCategory(e.target.value)}><option value="all">Todas las Categorías</option><option value="">Sin categoría</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          {canWrite && <button type="button" className="btn ghost catalog-manage" data-testid="categories-manage" aria-label="Administrar categorías" title="Administrar categorías" onClick={() => setManagingCategories(true)}><Settings2 size={18} aria-hidden="true" /></button>}
        </div>
      </div>
      {canWrite && <button className="btn primary" data-testid="product-new" onClick={() => { setEditing(null); setOpen(true); }}><Plus size={16} aria-hidden="true" /> Nuevo Producto</button>}
    </div>
    {error && <p className="error" role="alert" data-testid="catalog-error">{error} <button className="btn" onClick={() => void refresh()}>Reintentar catálogo</button></p>}
    {loading && <p role="status">Cargando catálogo…</p>}
    <div className="catalog-cards" aria-busy={loading}>
      {visible.map(p => <article className="catalog-tile" data-testid="product-item" key={p.id}>
        <div className="catalog-tile-head"><span className="catalog-category">{categories.find(c => c.id === p.category_id)?.name ?? "Sin categoría"}</span>{canWrite && <button className={`catalog-state ${p.active ? "is-active" : ""}`} data-testid="toggle-active" disabled={busy} aria-label={`${p.active ? "Desactivar" : "Reactivar"} ${p.name}`} onClick={() => void mutate(() => updateLocalProduct(db, tenantId, p.id, { active: !p.active }), `${p.active ? "Producto desactivado" : "Producto reactivado"} (pendiente de sync)`)}>{p.active ? "Activo" : "Inactivo"}</button>}</div>
        <h3>{p.photo ? <img data-testid="product-photo-thumb" src={p.photo} alt="" /> : <ProductIcon iconKey={p.icon_key} />} {p.name}</h3>
        <div className="catalog-variant-list">{p.variants.map(v => <div className="catalog-variant-summary" key={v.id}>
          <strong>{v.name}{!v.active && " · Inactiva"}</strong>
          <p className="catalog-sku">SKU: {v.code ?? "Sin código"}</p>
          <dl><div><dt>Precio Venta:</dt><dd className="catalog-price">{cop(v.price)}</dd></div><div><dt>Costo:</dt><dd>{v.cost == null ? "Sin configurar" : cop(v.cost)}</dd></div><div><dt>Stock Actual:</dt><dd className={v.stock <= (v.low_stock_threshold ?? 0) ? "catalog-low" : ""}>{v.stock} un.</dd></div></dl>
        </div>)}</div>
        {canWrite && <button className="btn catalog-edit" data-testid="product-edit" onClick={() => { setEditing(p); setOpen(true); }}><SquarePen size={14} aria-hidden="true" /> Editar</button>}
      </article>)}
    </div>
    {!loading && !error && !visible.length && <div className="empty-state" data-testid="empty-catalog-note"><h2>{products.length ? "Sin resultados" : "Catálogo vacío"}</h2><p>{products.length ? "Probá otra búsqueda o categoría." : canWrite ? "Creá el primer producto con Nuevo Producto para empezar a vender." : "El dueño o administrador puede cargar productos para empezar a vender."}</p></div>}
    <CategoryModal open={managingCategories} db={db} tenantId={tenantId} categories={categories} products={products} onClose={() => setManagingCategories(false)} onSaved={() => { void refresh(); onMutated(); showToast("Categoría creada (pendiente de sync)"); }} />
    <ProductModal open={open} product={editing} categories={categories} db={db} tenantId={tenantId} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); void refresh(); onMutated(); showToast(`${editing ? "Producto actualizado" : "Producto creado"} (pendiente de sync)`); }} />
  </section>;
}
