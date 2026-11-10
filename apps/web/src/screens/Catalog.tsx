import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { createProductInputSchema, priceSchema, variantCodeSchema } from "@pos/shared";
import {
  addLocalVariant,
  catalogError,
  adjustLocalStock,
  createLocalCategory,
  createLocalProduct,
  listCategories,
  listProducts,
  updateLocalProduct,
  updateLocalVariant,
  type LocalCategory,
  type LocalProduct,
} from "../db/local";
import { fileToPhotoDataUrl } from "../lib/photo";

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

type Props = {
  db: PGlite;
  tenantId: string;
  refreshToken: number;
  showToast: (msg: string) => void;
  onMutated: () => void;
};

export function Catalog({ db, tenantId, refreshToken, showToast, onMutated }: Props) {
  const [products, setProducts] = useState<LocalProduct[]>([]);
  const [categories, setCategories] = useState<LocalCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState<string>("all");

  // create form
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [variantName, setVariantName] = useState("");
  const [code, setCode] = useState("");
  const [codeDraft, setCodeDraft] = useState<Record<string, string>>({});
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [stock, setStock] = useState("");
  const [newCatName, setNewCatName] = useState("");

  // per-variant ephemeral editors
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  const [adjust, setAdjust] = useState<
    Record<string, { delta: string; reason: string; note: string }>
  >({});
  const [extraVariant, setExtraVariant] = useState<
    Record<string, { name: string; price: string; stock: string; code?: string }>
  >({});

  const refresh = useCallback(async () => {
    const [rows, cats] = await Promise.all([
      listProducts(db, tenantId),
      listCategories(db, tenantId),
    ]);
    setProducts(rows);
    setCategories(cats);
  }, [db, tenantId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  async function createCategory() {
    const n = newCatName.trim();
    if (!n) return;
    try {
      await createLocalCategory(db, tenantId, { name: n });
      setNewCatName("");
      await refresh();
      onMutated();
      showToast("Categoría creada");
    } catch {
      setError("No se pudo crear la categoría (¿ya existe?)");
    }
  }

  async function onPhotoPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const url = await fileToPhotoDataUrl(file);
      setPhoto(url);
    } catch {
      setError("No se pudo procesar la imagen (máx ~150KB comprimido)");
    }
  }

  async function createProduct(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = createProductInputSchema.safeParse({
      name,
      category_id: categoryId || null,
      photo: photo,
      variant: {
        name: variantName,
        code,
        price: Number(price),
        cost: cost === "" ? null : Number(cost),
        stock: Number(stock || 0),
      },
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Revisá los datos");
      return;
    }
    try {
      await createLocalProduct(db, tenantId, {
        name: parsed.data.name,
        category_id: parsed.data.category_id ?? null,
        photo: parsed.data.photo ?? null,
        variant: {
          name: parsed.data.variant.name,
          code: parsed.data.variant.code,
          price: parsed.data.variant.price,
          cost: parsed.data.variant.cost ?? null,
          stock: parsed.data.variant.stock,
        },
      });
      setName("");
      setVariantName("");
      setCode("");
      setPrice("");
      setCost("");
      setStock("");
      setPhoto(null);
      await refresh();
      onMutated();
      showToast("Producto creado (pendiente de sync)");
    } catch (err) {
      setError(catalogError(err));
    }
  }

  async function toggleActive(product: LocalProduct) {
    await updateLocalProduct(db, tenantId, product.id, { active: !product.active });
    await refresh();
    onMutated();
    showToast(product.active ? "Producto desactivado" : "Producto reactivado");
  }

  async function savePrice(variantId: string) {
    setError(null);
    const parsed = priceSchema.safeParse(Number(priceDraft[variantId]));
    if (!parsed.success) {
      setError("Precio inválido: enteros COP ≥ 0");
      return;
    }
    await updateLocalVariant(db, tenantId, variantId, { price: parsed.data });
    await refresh();
    onMutated();
    showToast("Precio actualizado (pendiente de sync)");
  }

  async function saveCode(variantId: string) {
    setError(null);
    const parsed = variantCodeSchema.safeParse(codeDraft[variantId]);
    if (!parsed.success) { setError("Código inválido: máximo 120 caracteres"); return; }
    try {
      await updateLocalVariant(db, tenantId, variantId, { code: parsed.data });
      setCodeDraft((previous) => {
        const next = { ...previous };
        delete next[variantId];
        return next;
      });
      await refresh();
      onMutated();
      showToast("Código actualizado (pendiente de sync)");
    } catch (err) { setError(catalogError(err)); }
  }

  async function saveCost(variantId: string) {
    setError(null);
    const raw = costDraft[variantId];
    if (raw === undefined) return;
    if (raw === "") {
      await updateLocalVariant(db, tenantId, variantId, { cost: null });
      await refresh();
      onMutated();
      showToast("Costo borrado");
      return;
    }
    const parsed = priceSchema.safeParse(Number(raw));
    if (!parsed.success) {
      setError("Costo inválido: enteros COP ≥ 0");
      return;
    }
    await updateLocalVariant(db, tenantId, variantId, { cost: parsed.data });
    await refresh();
    onMutated();
    showToast("Costo actualizado (pendiente de sync)");
  }

  async function submitAdjust(e: FormEvent, variantId: string) {
    e.preventDefault();
    setError(null);
    const draft = adjust[variantId] ?? { delta: "", reason: "", note: "" };
    const delta = Number(draft.delta);
    if (!Number.isInteger(delta) || !draft.reason.trim() || !draft.note.trim()) {
      setError("Ajuste inválido: delta entero, motivo y nota son obligatorios");
      return;
    }
    const res = await adjustLocalStock(db, tenantId, {
      variant_id: variantId,
      delta,
      reason: draft.reason.trim(),
      note: draft.note.trim(),
    });
    if (!res) {
      setError("Variante no encontrada");
      return;
    }
    setAdjust((prev) => ({ ...prev, [variantId]: { delta: "", reason: "", note: "" } }));
    await refresh();
    onMutated();
    showToast(`Stock ajustado → ${res.stock} (pendiente de sync)`);
  }

  async function submitExtraVariant(e: FormEvent, productId: string) {
    e.preventDefault();
    setError(null);
    const draft = extraVariant[productId] ?? { name: "", price: "", stock: "" };
    const parsed = createProductInputSchema.shape.variant.safeParse({
      name: draft.name,
      code: "code" in draft ? draft.code : null,
      price: Number(draft.price),
      stock: Number(draft.stock || 0),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Revisá la variante");
      return;
    }
    try {
      const created = await addLocalVariant(db, tenantId, productId, {
        name: parsed.data.name,
        code: parsed.data.code,
        price: parsed.data.price,
        stock: parsed.data.stock,
      });
      if (!created) {
        setError("Producto no encontrado");
        return;
      }
      setExtraVariant((prev) => ({ ...prev, [productId]: { name: "", price: "", stock: "" } }));
      await refresh();
      onMutated();
      showToast("Talla agregada (pendiente de sync)");
    } catch (err) { setError(catalogError(err)); }
  }

  const q = search.trim().toLowerCase();
  const visible = products.filter((p) => {
    if (filterCat !== "all" && (p.category_id ?? "") !== filterCat) return false;
    if (!q) return true;
    if (p.name.toLowerCase().includes(q)) return true;
    return p.variants.some((v) => v.name.toLowerCase().includes(q) || v.code?.toLowerCase().includes(q));
  });

  const catName = (id: string | null) =>
    id ? (categories.find((c) => c.id === id)?.name ?? "—") : "Sin categoría";

  return (
    <div className="screen catalog">
      <form className="card" onSubmit={createProduct}>
        <h2>Nuevo producto</h2>

        <div className="cat-create-row">
          <div style={{ flex: 1 }}>
            <label htmlFor="p-name">Nombre</label>
            <input
              id="p-name"
              data-testid="product-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Granizado de Fresa"
              required
            />
          </div>
        </div>

        <label htmlFor="v-code">SKU / código de barras — opcional por variante</label>
        <input id="v-code" data-testid="variant-code" type="text" maxLength={120}
          autoComplete="off" autoCapitalize="none" spellCheck={false}
          value={code} onChange={(e) => setCode(e.target.value)} placeholder="Ej. 001234567890" />

        <div className="grid-2">
          <div>
            <label htmlFor="p-cat">Categoría</label>
            <select
              id="p-cat"
              data-testid="product-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Sin categoría</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="p-photo">Foto</label>
            <input
              id="p-photo"
              data-testid="product-photo"
              type="file"
              accept="image/*"
              className="photo-input"
              onChange={(e) => void onPhotoPick(e.target.files?.[0])}
            />
          </div>
        </div>

        {photo && (
          <div className="photo-preview">
            <img src={photo} alt="Vista previa" data-testid="photo-preview" />
            <button
              type="button"
              className="btn small ghost"
              onClick={() => setPhoto(null)}
            >
              Quitar foto
            </button>
          </div>
        )}

        <div className="grid-2">
          <div>
            <label htmlFor="v-name">Talla / variante</label>
            <input
              id="v-name"
              data-testid="variant-name"
              value={variantName}
              onChange={(e) => setVariantName(e.target.value)}
              placeholder="Grande"
              required
            />
          </div>
          <div>
            <label htmlFor="v-price">Precio venta (COP)</label>
            <input
              id="v-price"
              data-testid="variant-price"
              inputMode="numeric"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="4000"
              required
            />
          </div>
        </div>

        <div className="grid-2">
          <div>
            <label htmlFor="v-cost">Costo (COP) — opcional</label>
            <input
              id="v-cost"
              data-testid="variant-cost"
              inputMode="numeric"
              value={cost}
              onChange={(e) => setCost(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="2500"
            />
          </div>
          <div>
            <label htmlFor="v-stock">Stock inicial</label>
            <input
              id="v-stock"
              data-testid="variant-stock"
              inputMode="numeric"
              value={stock}
              onChange={(e) => setStock(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="0"
            />
          </div>
        </div>

        {error && (
          <p className="error" data-testid="catalog-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary" data-testid="product-create">
          Crear producto
        </button>
      </form>

      <div className="card cat-manage">
        <h3>Categorías</h3>
        <div className="row gap">
          <input
            aria-label="Nueva categoría"
            data-testid="new-category-name"
            placeholder="Ej. Granizados"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
          />
          <button
            type="button"
            className="btn small"
            data-testid="category-create"
            onClick={() => void createCategory()}
          >
            Agregar
          </button>
        </div>
        {categories.length > 0 && (
          <div className="cat-chips" role="list">
            <button
              type="button"
              className={`cat-chip${filterCat === "all" ? " active" : ""}`}
              data-testid="filter-all"
              onClick={() => setFilterCat("all")}
            >
              Todas ({products.length})
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`cat-chip${filterCat === c.id ? " active" : ""}`}
                data-testid="filter-category"
                onClick={() => setFilterCat(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="catalog-toolbar">
        <h2 style={{ margin: 0 }}>Catálogo ({visible.length})</h2>
        <input
          className="search-input"
          data-testid="catalog-search"
          type="search"
          placeholder="Buscar nombre, SKU o código…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar en catálogo"
        />
      </div>

      <div className="product-grid">
        {visible.map((product) => (
          <div
            key={product.id}
            className={`card product-card ${product.active ? "" : "inactive"}`}
            data-testid="product-item"
          >
            <div className="product-card-head">
              {product.photo ? (
                <img
                  className="product-thumb"
                  src={product.photo}
                  alt=""
                  data-testid="product-photo-thumb"
                />
              ) : (
                <div className="product-thumb placeholder" aria-hidden>
                  {product.name.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="product-card-title">
                <strong>{product.name}</strong>
                <span className="muted cat-label">{catName(product.category_id)}</span>
              </div>
              <button
                className={`btn small ${product.active ? "danger" : "ghost"}`}
                data-testid="toggle-active"
                onClick={() => toggleActive(product)}
              >
                {product.active ? "Desactivar" : "Reactivar"}
              </button>
            </div>

            {product.variants.map((v) => (
              <div key={v.id} className="variant-row" data-testid="variant-row">
                <div className="row gap">
                  <input aria-label={`Código ${product.name} ${v.name}`} data-testid="code-input"
                    type="text" maxLength={120} autoComplete="off" autoCapitalize="none" spellCheck={false}
                    placeholder="SKU / código (opcional)" value={codeDraft[v.id] ?? v.code ?? ""}
                    onChange={(e) => setCodeDraft((prev) => ({ ...prev, [v.id]: e.target.value }))} />
                  <button type="button" className="btn small" data-testid="save-code"
                    disabled={codeDraft[v.id] === undefined} onClick={() => void saveCode(v.id)}>Guardar código</button>
                </div>
                <div className="row space-between">
                  <span>
                    {v.name} · stock <strong>{v.stock}</strong>
                  </span>
                  <span className="muted">
                    {cop(v.price)}
                    {v.cost != null && (
                      <span className="margin-tag" title="Costo">
                        {" "}
                        · mrg {cop(v.price - v.cost)}
                      </span>
                    )}
                  </span>
                </div>
                <div className="row gap">
                  <input
                    aria-label={`Precio ${product.name} ${v.name}`}
                    data-testid="price-input"
                    inputMode="numeric"
                    value={priceDraft[v.id] ?? String(v.price)}
                    onChange={(e) =>
                      setPriceDraft((prev) => ({
                        ...prev,
                        [v.id]: e.target.value.replace(/[^\d]/g, ""),
                      }))
                    }
                  />
                  <button
                    className="btn small"
                    data-testid="save-price"
                    onClick={() => savePrice(v.id)}
                  >
                    Guardar precio
                  </button>
                  <button
                    className="btn small ghost"
                    data-testid="open-adjust"
                    onClick={() =>
                      setAdjust((prev) => ({
                        ...prev,
                        [v.id]: prev[v.id] ?? { delta: "", reason: "", note: "" },
                      }))
                    }
                  >
                    Ajustar stock
                  </button>
                </div>
                <div className="row gap">
                  <input
                    aria-label={`Costo ${product.name} ${v.name}`}
                    data-testid="cost-input"
                    inputMode="numeric"
                    placeholder="Costo"
                    value={costDraft[v.id] ?? (v.cost != null ? String(v.cost) : "")}
                    onChange={(e) =>
                      setCostDraft((prev) => ({
                        ...prev,
                        [v.id]: e.target.value.replace(/[^\d]/g, ""),
                      }))
                    }
                  />
                  <button
                    className="btn small"
                    data-testid="save-cost"
                    onClick={() => saveCost(v.id)}
                  >
                    Guardar costo
                  </button>
                </div>

                {adjust[v.id] && (
                  <form
                    className="adjust-form"
                    onSubmit={(e) => submitAdjust(e, v.id)}
                    data-testid="adjust-form"
                  >
                    <input
                      aria-label="Delta"
                      data-testid="adjust-delta"
                      inputMode="numeric"
                      placeholder="p.ej. 4 o -2"
                      value={adjust[v.id].delta}
                      onChange={(e) =>
                        setAdjust((prev) => ({
                          ...prev,
                          [v.id]: { ...prev[v.id], delta: e.target.value.replace(/[^\d-]/g, "") },
                        }))
                      }
                    />
                    <input
                      aria-label="Motivo"
                      data-testid="adjust-reason"
                      placeholder="Motivo (obligatorio)"
                      value={adjust[v.id].reason}
                      onChange={(e) =>
                        setAdjust((prev) => ({
                          ...prev,
                          [v.id]: { ...prev[v.id], reason: e.target.value },
                        }))
                      }
                    />
                    <input
                      aria-label="Nota"
                      data-testid="adjust-note"
                      placeholder="Nota (obligatoria)"
                      value={adjust[v.id].note}
                      onChange={(e) =>
                        setAdjust((prev) => ({
                          ...prev,
                          [v.id]: { ...prev[v.id], note: e.target.value },
                        }))
                      }
                    />
                    <button type="submit" className="btn small primary">
                      Aplicar ajuste
                    </button>
                  </form>
                )}
              </div>
            ))}

            <form
              className="extra-variant"
              onSubmit={(e) => submitExtraVariant(e, product.id)}
            >
              <input aria-label="Código nueva variante" data-testid="extra-variant-code" type="text"
                maxLength={120} autoComplete="off" autoCapitalize="none" spellCheck={false}
                placeholder="SKU / código (opcional)" value={extraVariant[product.id]?.code ?? ""}
                onChange={(e) => setExtraVariant((prev) => ({ ...prev, [product.id]: {
                  name: prev[product.id]?.name ?? "", price: prev[product.id]?.price ?? "",
                  stock: prev[product.id]?.stock ?? "", code: e.target.value,
                } }))} />
              <div className="row gap">
                <input
                  aria-label="Nueva talla"
                  data-testid="extra-variant-name"
                  placeholder="Talla…"
                  value={extraVariant[product.id]?.name ?? ""}
                  onChange={(e) =>
                    setExtraVariant((prev) => ({
                      ...prev,
                      [product.id]: {
                        name: e.target.value,
                        code: prev[product.id]?.code,
                        price: prev[product.id]?.price ?? "",
                        stock: prev[product.id]?.stock ?? "",
                      },
                    }))
                  }
                />
                <input
                  aria-label="Precio nueva talla"
                  data-testid="extra-variant-price"
                  inputMode="numeric"
                  placeholder="Precio"
                  value={extraVariant[product.id]?.price ?? ""}
                  onChange={(e) =>
                    setExtraVariant((prev) => ({
                      ...prev,
                      [product.id]: {
                        name: prev[product.id]?.name ?? "",
                        code: prev[product.id]?.code,
                        price: e.target.value.replace(/[^\d]/g, ""),
                        stock: prev[product.id]?.stock ?? "",
                      },
                    }))
                  }
                />
                <button type="submit" className="btn small" data-testid="add-variant">
                  + Talla
                </button>
              </div>
            </form>
          </div>
        ))}
      </div>

      {visible.length === 0 && (
        <div className="empty-state" data-testid="empty-catalog-note">
          <h2>
            {products.length === 0 ? "Catálogo vacío" : "Sin resultados"}
          </h2>
          <p className="muted">
            {products.length === 0
              ? "Creá el primer producto arriba para empezar a vender."
              : "Probá otra búsqueda o quitá el filtro de categoría."}
          </p>
        </div>
      )}
    </div>
  );
}
