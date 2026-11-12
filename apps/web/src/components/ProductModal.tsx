import { useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { PRODUCT_ICON_KEYS, type ProductIconKey } from "@pos/shared";
import { catalogError, saveLocalCatalogProduct, type LocalCategory, type LocalProduct } from "../db/local";
import { fileToPhotoDataUrl } from "../lib/photo";
import { ProductIcon } from "./ProductIcon";

type VariantDraft = { id?: string; name: string; code: string; price: string; cost: string; stock: string; reason: string; note: string; currentStock?: number };
const blank = (): VariantDraft => ({ name: "", code: "", price: "", cost: "", stock: "", reason: "", note: "" });
type Props = { open: boolean; product: LocalProduct | null; categories: LocalCategory[]; db: PGlite; tenantId: string; onClose: () => void; onSaved: () => void };

export function ProductModal({ open, product, categories, db, tenantId, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const photoJob = useRef(0);
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [icon, setIcon] = useState<ProductIconKey | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [variants, setVariants] = useState<VariantDraft[]>([blank()]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) {
      setName(product?.name ?? ""); setCategory(product?.category_id ?? ""); setIcon(product?.icon_key ?? null); setPhoto(product?.photo ?? null); setActive(product?.active ?? true);
      setVariants(product?.variants.map(v => ({ ...blank(), id: v.id, name: v.name, code: v.code ?? "", price: String(v.price), cost: v.cost == null ? "" : String(v.cost), stock: "", currentStock: v.stock })) ?? [blank()]);
      setError(null); setBusy(false); setProcessing(false); busyRef.current = false; photoJob.current++;
      dialog.current?.showModal();
      dialog.current?.querySelector<HTMLInputElement>("#product-name")?.focus();
    } else if (!open) { photoJob.current++; dialog.current?.close(); }
  }, [open, product]);
  const close = () => { if (!busyRef.current) { photoJob.current++; dialog.current?.close(); onClose(); } };
  const change = (index: number, patch: Partial<VariantDraft>) => setVariants(rows => rows.map((v, i) => i === index ? { ...v, ...patch } : v));
  async function pick(file?: File) {
    if (!file) return;
    const job = ++photoJob.current;
    setProcessing(true); setError(null);
    try { const url = await fileToPhotoDataUrl(file); if (job === photoJob.current) setPhoto(url); }
    catch { if (job === photoJob.current) setError("No se pudo procesar la imagen (máx ~150KB comprimido)"); }
    finally { if (job === photoJob.current) setProcessing(false); }
  }
  async function save() {
    if (busyRef.current || processing) return;
    const integer = (value: string, optional = false) => {
      if (optional && value.trim() === "") return 0;
      if (!/^-?\d+$/.test(value.trim())) throw new Error("Precio, costo y stock deben ser enteros; no decimales");
      return Number(value);
    };
    setError(null);
    busyRef.current = true; setBusy(true);
    try {
      await saveLocalCatalogProduct(db, tenantId, { id: product?.id, product: { name, category_id: category || null, icon_key: icon, photo, active }, variants: variants.map(v => ({ ...v, price: integer(v.price), cost: v.cost.trim() === "" ? null : integer(v.cost), code: v.code || null, stock: integer(v.stock, true) })) });
      dialog.current?.close(); onSaved();
    } catch (err) {
      const issue = (err as { issues?: Array<{ path: string[]; message: string }> })?.issues?.[0];
      const field = issue?.path.at(-1);
      setError(issue ? ({ name: "Ingresá un nombre válido para el producto y cada variante", price: "Precio inválido: enteros COP ≥ 0", cost: "Costo inválido: enteros COP ≥ 0", reason: "Ingresá el motivo del ajuste", note: "Ingresá la nota del ajuste" }[field ?? ""] ?? `Revisá los datos: ${issue.message}`) : catalogError(err));
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="product-modal" data-testid="product-modal" aria-labelledby="product-modal-title" onCancel={e => { if (busyRef.current) e.preventDefault(); else { photoJob.current++; onClose(); } }}>
    {open && <><div className="modal-head"><h3 id="product-modal-title">{product ? "Editar Producto" : "Nuevo Producto"}</h3><button type="button" className="modal-x" aria-label="Cerrar producto" disabled={busy} onClick={close}>✕</button></div>
      <form className="modal-form" noValidate onSubmit={e => { e.preventDefault(); void save(); }} aria-busy={busy}>
        <fieldset disabled={busy} className="product-fields" aria-describedby={error ? "product-error" : undefined}>
          <label htmlFor="product-name">Nombre del Producto</label><input autoFocus id="product-name" data-testid="product-name" aria-describedby={error ? "product-error" : undefined} maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Bebida Energizante 500ml" />
          {variants.map((v, index) => <section className="product-variant-editor" data-testid="variant-row" key={v.id ?? `new-${index}`} aria-label={`Variante ${index + 1}`}>
            <label htmlFor={`variant-name-${index}`}>Talla / variante {index + 1}</label><input id={`variant-name-${index}`} data-testid="variant-name" value={v.name} maxLength={80} placeholder="Grande" onChange={e => change(index, { name: e.target.value })} />
            <div className={index === 0 ? "product-code-category" : undefined}>
              <div><label htmlFor={`variant-code-${index}`}>SKU / Código Bar</label><input id={`variant-code-${index}`} data-testid="variant-code" aria-describedby={error ? "product-error" : undefined} className="mono" maxLength={120} autoComplete="off" autoCapitalize="none" spellCheck={false} value={v.code} onChange={e => change(index, { code: e.target.value })} /></div>
              {index === 0 && <div><label htmlFor="product-category">Categoría</label><select id="product-category" data-testid="product-category" value={category} onChange={e => setCategory(e.target.value)}><option value="">Sin categoría</option>{categories.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></div>}
            </div>
            <div className="product-number-grid"><div><label htmlFor={`price-${index}`}>Precio Venta</label><input id={`price-${index}`} data-testid="variant-price" aria-describedby={error ? "product-error" : undefined} inputMode="numeric" value={v.price} onChange={e => change(index, { price: e.target.value })} /></div><div><label htmlFor={`cost-${index}`}>Costo (opcional)</label><input id={`cost-${index}`} data-testid="variant-cost" aria-describedby={error ? "product-error" : undefined} inputMode="numeric" value={v.cost} onChange={e => change(index, { cost: e.target.value })} /></div><div><label htmlFor={`stock-${index}`}>{v.id ? "Ajuste (+/−)" : "Stock Inicial"}</label><input id={`stock-${index}`} data-testid="variant-stock" aria-describedby={error ? "product-error" : undefined} inputMode="numeric" placeholder="0" value={v.stock} onChange={e => change(index, { stock: e.target.value })} /></div></div>
            {v.id && <><p className="muted">Stock al abrir: {v.currentStock} un. El ajuste se suma al stock vigente.</p>{v.stock !== "" && Number(v.stock) !== 0 && <div className="product-adjust"><label htmlFor={`reason-${index}`}>Motivo obligatorio</label><input id={`reason-${index}`} data-testid="adjust-reason" maxLength={60} value={v.reason} onChange={e => change(index, { reason: e.target.value })} /><label htmlFor={`note-${index}`}>Nota obligatoria</label><input id={`note-${index}`} data-testid="adjust-note" maxLength={240} value={v.note} onChange={e => change(index, { note: e.target.value })} /></div>}</>}
            {!v.id && variants.length > 1 && <button type="button" className="btn ghost" onClick={() => setVariants(rows => rows.filter((_, i) => i !== index))}>Quitar variante nueva</button>}
          </section>)}
          <button type="button" className="btn ghost" data-testid="add-variant" onClick={() => setVariants(rows => [...rows, blank()])}>+ Agregar variante</button>
          <details className="product-additional"><summary>Foto, icono y estado</summary><label htmlFor="product-icon">Icono</label><div className="row gap"><ProductIcon iconKey={icon} /><select id="product-icon" data-testid="product-icon" value={icon ?? ""} onChange={e => setIcon((e.target.value || null) as ProductIconKey | null)}><option value="">Predeterminado</option>{PRODUCT_ICON_KEYS.map(key => <option key={key}>{key}</option>)}</select></div><label htmlFor="product-photo">Foto</label><input id="product-photo" data-testid="product-photo" type="file" accept="image/*" disabled={processing} onChange={e => void pick(e.target.files?.[0])} />{processing && <p role="status">Procesando imagen…</p>}{photo && <div className="photo-preview"><img src={photo} alt="Vista previa" data-testid="photo-preview" /><button className="btn ghost" type="button" onClick={() => setPhoto(null)}>Quitar foto</button></div>}{product && <label className="check-row"><input type="checkbox" data-testid="product-active" checked={active} onChange={e => setActive(e.target.checked)} /> Producto activo</label>}</details>
        </fieldset>
        {error && <p id="product-error" className="error" role="alert" data-testid="catalog-error">{error}</p>}
        <div className="modal-actions"><button type="button" className="btn ghost" disabled={busy} onClick={close}>Cancelar</button><button type="submit" className="btn primary" data-testid="product-create" disabled={busy || processing} aria-busy={busy}>{busy ? "Guardando…" : "Guardar Producto"}</button></div>
      </form></>}
  </dialog>;
}
