import { useCallback, useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { Plus, Search, SquarePen } from "lucide-react";
import { catalogError, createLocalCategory, listCategories, listProducts, updateLocalProduct, type LocalCategory, type LocalProduct } from "../db/local";
import { ProductIcon } from "../components/ProductIcon";
import { ProductModal } from "../components/ProductModal";

const cop = (n: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
type Props = { db: PGlite; tenantId: string; refreshToken: number; showToast: (msg: string) => void; onMutated: () => void; pendingVariantId?: string | null; onPendingVariantUsed?: () => void };

export function Catalog({ db, tenantId, refreshToken, showToast, onMutated, pendingVariantId, onPendingVariantUsed }: Props) {
  const [products, setProducts] = useState<LocalProduct[]>([]);
  const [categories, setCategories] = useState<LocalCategory[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [newCategory, setNewCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LocalProduct | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [rows, cats] = await Promise.all([listProducts(db, tenantId), listCategories(db, tenantId)]);
      setProducts(rows); setCategories(cats);
    } catch (err) { setError(catalogError(err)); }
    finally { setLoading(false); }
  }, [db, tenantId]);
  useEffect(() => { void refresh(); }, [refresh, refreshToken]);
  useEffect(() => {
    if (!pendingVariantId) return;
    const product = products.find(p => p.variants.some(v => v.id === pendingVariantId));
    if (product) { setEditing(product); setOpen(true); onPendingVariantUsed?.(); }
  }, [products, pendingVariantId, onPendingVariantUsed]);
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
        <select aria-label="Filtrar categoría" data-testid="catalog-category-filter" value={category} onChange={e => setCategory(e.target.value)}><option value="all">Todas las Categorías</option><option value="">Sin categoría</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </div>
      <button className="btn primary" data-testid="product-new" onClick={() => { setEditing(null); setOpen(true); }}><Plus size={16} aria-hidden="true" /> Nuevo Producto</button>
    </div>
    {error && <p className="error" role="alert" data-testid="catalog-error">{error}</p>}
    {loading && <p role="status">Cargando catálogo…</p>}
    <div className="catalog-cards" aria-busy={loading}>
      {visible.map(p => <article className="catalog-tile" data-testid="product-item" key={p.id}>
        <div className="catalog-tile-head"><span className="catalog-category">{categories.find(c => c.id === p.category_id)?.name ?? "Sin categoría"}</span><button className={`catalog-state ${p.active ? "is-active" : ""}`} data-testid="toggle-active" disabled={busy} aria-label={`${p.active ? "Desactivar" : "Reactivar"} ${p.name}`} onClick={() => void mutate(() => updateLocalProduct(db, tenantId, p.id, { active: !p.active }), `${p.active ? "Producto desactivado" : "Producto reactivado"} (pendiente de sync)`)}>{p.active ? "Activo" : "Inactivo"}</button></div>
        <h3>{p.photo ? <img data-testid="product-photo-thumb" src={p.photo} alt="" /> : <ProductIcon iconKey={p.icon_key} />} {p.name}</h3>
        <div className="catalog-variant-list">{p.variants.map(v => <div className="catalog-variant-summary" key={v.id}>
          <strong>{v.name}{!v.active && " · Inactiva"}</strong>
          <p className="catalog-sku">SKU: {v.code ?? "Sin código"}</p>
          <dl><div><dt>Precio Venta:</dt><dd className="catalog-price">{cop(v.price)}</dd></div><div><dt>Costo:</dt><dd>{v.cost == null ? "Sin configurar" : cop(v.cost)}</dd></div><div><dt>Stock Actual:</dt><dd className={v.stock <= (v.low_stock_threshold ?? 0) ? "catalog-low" : ""}>{v.stock} un.</dd></div></dl>
        </div>)}</div>
        <button className="btn catalog-edit" data-testid="product-edit" onClick={() => { setEditing(p); setOpen(true); }}><SquarePen size={14} aria-hidden="true" /> Editar</button>
      </article>)}
    </div>
    {!loading && !visible.length && <div className="empty-state" data-testid="empty-catalog-note"><h2>{products.length ? "Sin resultados" : "Catálogo vacío"}</h2><p>{products.length ? "Probá otra búsqueda o categoría." : "Creá el primer producto con Nuevo Producto para empezar a vender."}</p></div>}
    <details className="catalog-categories"><summary>Administrar categorías</summary><form onSubmit={e => { e.preventDefault(); if (newCategory.trim()) void mutate(async () => { await createLocalCategory(db, tenantId, { name: newCategory.trim() }); setNewCategory(""); }, "Categoría creada (pendiente de sync)"); }}><label htmlFor="new-category">Nueva categoría</label><div className="row gap"><input id="new-category" data-testid="new-category-name" maxLength={60} required value={newCategory} onChange={e => setNewCategory(e.target.value)} /><button className="btn" data-testid="category-create" disabled={busy}>Agregar</button></div></form></details>
    <ProductModal open={open} product={editing} categories={categories} db={db} tenantId={tenantId} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); void refresh(); onMutated(); showToast(`${editing ? "Producto actualizado" : "Producto creado"} (pendiente de sync)`); }} />
  </section>;
}
