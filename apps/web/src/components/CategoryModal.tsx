import { useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { catalogError, createLocalCategory, type LocalCategory, type LocalProduct } from "../db/local";

/**
 * Modal «Administrar categorías» — the ONE surface behind the toolbar's
 * manage affordance (it replaces the disclosure that used to hang under the
 * product grid).
 *
 * Native <dialog> like ProductModal/TableModal: focus return, Escape (except
 * while saving), inert background. It STAYS OPEN after a create so several
 * categories can be entered in a row — the input clears and keeps focus.
 *
 * The list is read-only context (what exists + how many products use it):
 * create was, and still is, the only write this surface offers.
 */
type Props = {
  open: boolean;
  db: PGlite;
  tenantId: string;
  categories: LocalCategory[];
  products: LocalProduct[];
  onClose: () => void;
  onSaved: () => void;
};

export function CategoryModal({ open, db, tenantId, categories, products, onClose, onSaved }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setName(""); setError(null); setBusy(false); busyRef.current = false;
      dialog.showModal();
      dialog.querySelector<HTMLInputElement>("#new-category")?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function requestClose() {
    if (busyRef.current) return;
    dialogRef.current?.close();
    onClose();
  }

  async function create() {
    if (busyRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) { setError("Ingresá el nombre de la categoría"); return; }
    busyRef.current = true; setBusy(true); setError(null);
    try {
      await createLocalCategory(db, tenantId, { name: trimmed });
      setName("");
      onSaved();
      /* batch entry: the submit click moved focus to the button — hand it
       * back to the input so the next name can be typed straight away. */
      dialogRef.current?.querySelector<HTMLInputElement>("#new-category")?.focus();
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      setError(e?.code === "23505" && e.constraint === "categories_tenant_name_uq" ? "Ya existe una categoría con ese nombre" : catalogError(err));
    } finally { busyRef.current = false; setBusy(false); }
  }

  return <dialog ref={dialogRef} className="category-modal" data-testid="category-modal" aria-labelledby="category-modal-title" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    {open && <><div className="modal-head"><h3 id="category-modal-title">Administrar categorías</h3><button type="button" className="modal-x" data-testid="category-modal-close" aria-label="Cerrar" disabled={busy} onClick={requestClose}>✕</button></div>
      <form className="modal-form" noValidate onSubmit={e => { e.preventDefault(); void create(); }} aria-busy={busy}>
        <label htmlFor="new-category">Nueva categoría</label>
        <div className="row gap">
          {/* not disabled while busy: disabling the field would drop focus the
               moment the submit button greys out (batch entry needs it back) */}
          <input id="new-category" data-testid="new-category-name" maxLength={60} autoFocus autoComplete="off" aria-describedby={error ? "category-error" : undefined} placeholder="Ej: Bebidas" value={name} onChange={e => setName(e.target.value)} />
          <button type="submit" className="btn primary" data-testid="category-create" disabled={busy} aria-busy={busy}>{busy ? "Agregando…" : "Agregar"}</button>
        </div>
        {error && <p id="category-error" className="error" role="alert" data-testid="category-error">{error}</p>}
      </form>
      <ul className="category-list" data-testid="category-list" aria-label="Categorías existentes">
        {!categories.length && <li className="muted" data-testid="category-list-empty">Sin categorías todavía.</li>}
        {categories.map(c => {
          const count = products.filter(p => p.category_id === c.id).length;
          return <li key={c.id} data-testid="category-list-item"><span className="category-list-name">{c.name}</span><span className="category-list-count">{count} {count === 1 ? "producto" : "productos"}</span></li>;
        })}
      </ul>
      <div className="modal-actions"><button type="button" className="btn ghost" data-testid="category-close" disabled={busy} onClick={requestClose}>Cerrar</button></div>
    </>}
  </dialog>;
}
