import { useState } from "react";
import type { CustomRef, Production, ProductionShot, ReferenceCategory } from "../../../../shared/ipc.js";
import { cascadeMedia } from "./animatic.js";
import { useExternalImageMenu } from "../external-menu.js";
import { usePersistedCollapsed } from "./persisted-state.js";

interface RefItem {
  id: string;
  name: string;
  artwork?: string;
}

/** Grid of named reference slots: pick a name (populated from the script) and
 *  attach an image via the native file picker. With `onAdd`, also offers a
 *  form to create a brand-new character/product the script missed. */
function RefSection({ title, items, emptyHint, onAttach, onRemove, onAdd, addKind }: {
  title: string;
  items: RefItem[];
  emptyHint: string;
  onAttach: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (name: string, key: string) => void;
  addKind: string;
}) {
  const [picked, setPicked] = useState("");
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [addKey, setAddKey] = useState("");
  const withArt = items.filter((i) => i.artwork);
  const withoutArt = items.filter((i) => !i.artwork);
  const submit = () => {
    if (!addName.trim()) return;
    onAdd(addName, addKey);
    setAddName(""); setAddKey(""); setAdding(false);
  };
  return (
    <div className="prod-refs">
      <label className="prod-label">{title}</label>
      {withArt.length > 0 && (
        <div className="prod-ref-grid">
          {withArt.map((i) => (
            <figure key={i.id} className="prod-ref">
              <img src={i.artwork} alt={i.name} />
              <figcaption>{i.name}</figcaption>
              <button className="prod-ref-remove" title="Remove this reference" onClick={() => onRemove(i.id)}>×</button>
            </figure>
          ))}
        </div>
      )}
      {items.length === 0 ? (
        <p className="hint">{emptyHint}</p>
      ) : withoutArt.length === 0 ? (
        <p className="hint">All {items.length} have reference images.</p>
      ) : (
        <div className="prod-ref-add">
          <select value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">Choose a name…</option>
            {withoutArt.map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>
          <button disabled={!picked} onClick={() => { onAttach(picked); setPicked(""); }}>
            Add image…
          </button>
        </div>
      )}
      <div className="prod-ref-new">
          {adding ? (
            <>
              <input className="prod-ref-new-name" placeholder={`${addKind} name`} value={addName} onChange={(e) => setAddName(e.target.value)} autoFocus />
              {addKind === "character" && (
                <input className="prod-ref-new-key" placeholder="Visual descriptor (optional)" value={addKey} onChange={(e) => setAddKey(e.target.value)} />
              )}
              <button className="prod-btn" disabled={!addName.trim()} onClick={submit}>Add {addKind}</button>
              <button className="prod-btn ghost" onClick={() => { setAdding(false); setAddName(""); setAddKey(""); }}>Cancel</button>
            </>
          ) : (
            <button className="prod-btn" onClick={() => setAdding(true)}>＋ Add {addKind}…</button>
          )}
        </div>
    </div>
  );
}

/** Step 2: user-created references. Each reference is just a name and image;
 * any direction belongs in the storyboard frame prompt. */
function CustomRefSection({ items, onAdd, onAttach, onRemoveImage, onRemove, onUpdate }: {
  items: RefItem[];
  onAdd: (name: string) => void;
  onAttach: (id: string) => void;
  onRemoveImage: (id: string) => void;
  onRemove: (id: string) => void;
  /** Rename a reference in place. */
  onUpdate: (id: string, patch: Partial<{ name: string }>) => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    onAdd(name);
    setName(""); setPicked("");
  };
  return (
    <div className="prod-refs">
      <label className="prod-label">Custom references</label>
      <p className="hint">Materials, textures, mood shots, hero props — associate each to shots in Storyboard.</p>
      <div className="prod-ref-grid">
        {items.map((i) => (
          <figure key={i.id} className="prod-ref">
            {i.artwork ? <img src={i.artwork} alt={i.name} /> : <div className="prod-ref-blank">…</div>}
            <figcaption>
              <input
                className="prod-ref-name prod-ref-edit-name"
                value={i.name}
                placeholder="Reference name"
                onChange={(e) => onUpdate(i.id, { name: e.target.value })}
                title="Rename this reference"
              />
            </figcaption>
            {i.artwork
              ? <button className="prod-ref-remove" title="Remove reference image" onClick={() => onRemoveImage(i.id)}>×</button>
              : <button className="prod-ref-addimg" title="Attach a reference image" onClick={() => void onAttach(i.id)}>＋</button>}
            <button className="prod-ref-del" title="Delete this reference" onClick={() => onRemove(i.id)}>🗑</button>
          </figure>
        ))}
      </div>
      <div className="prod-ref-new form">
        <input className="prod-ref-new-name" placeholder="Reference name (e.g. Gondola Interior)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="prod-btn" disabled={!name.trim()} onClick={submit}>＋ Add reference…</button>
      </div>
    </div>
  );
}

export function ReferenceCategorySection({ prodId, categories, items, onAddCategory, onRenameCategory, onAddReference, onAttach, onRemove, onRename, onMove }: {
  prodId: string;
  categories: ReferenceCategory[];
  items: CustomRef[];
  onAddCategory: (name: string) => void;
  onRenameCategory: (id: string, name: string) => void;
  onAddReference: (name: string, categoryId?: string, artwork?: string) => void;
  onAttach: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, categoryId?: string) => void;
}) {
  const [categoryName, setCategoryName] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const add = () => { if (name.trim()) { onAddReference(name, categoryId || undefined); setName(""); } };
  const groups = [{ id: "", name: "Uncategorized" }, ...categories];
  return (
    <div className="prod-refs">
      <label className="prod-label">Reference images</label>
      <p className="hint">Create categories for your references, then drag images between them. Paste an image (Ctrl+V) to create a reference — drag a reference onto <em>From image</em> to generate a style.</p>
      <div className="prod-category-new">
        <input className="prod-ref-new-name" value={categoryName} placeholder="New category name" onChange={(e) => setCategoryName(e.target.value)} />
        <button className="prod-btn" disabled={!categoryName.trim()} onClick={() => { onAddCategory(categoryName); setCategoryName(""); }}>＋ Add category</button>
      </div>
<div className="prod-category-list">
        {groups.map((category) => (
          <CategoryPanel key={category.id || "uncategorized"} prodId={prodId} category={category} items={items.filter((r) => (r.categoryId ?? "") === category.id)} onAddReference={onAddReference} onAttach={onAttach} onRemove={onRemove} onRename={onRename} onRenameCategory={onRenameCategory} onMove={onMove} />
        ))}
      </div>
      <div className="prod-ref-new form">
        <input className="prod-ref-new-name" placeholder="Reference name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="prod-openart-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Uncategorized</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="prod-btn" disabled={!name.trim()} onClick={add}>＋ Add reference</button>
      </div>
    </div>
  );
}


/** One collapsible category panel in the reference grid. Drop targets accept
 *  existing references (move) or pasted/dropped image files (create). */
function CategoryPanel({ prodId, category, items, onAddReference, onAttach, onRemove, onRename, onRenameCategory, onMove }: {
  prodId: string;
  category: ReferenceCategory;
  items: CustomRef[];
  onAddReference: (name: string, categoryId?: string, artwork?: string) => void;
  onAttach: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRenameCategory: (id: string, name: string) => void;
  onMove: (id: string, categoryId?: string) => void;
}) {
  const [collapsed, setCollapsed] = usePersistedCollapsed(`cascade.prod.${prodId}.refcat.${category.id || "uncategorized"}`);
  const open = !collapsed;
  return (
    <section className="prod-category" onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("dragover"); }} onDragLeave={(e) => e.currentTarget.classList.remove("dragover")} onDrop={(e) => {
      e.preventDefault(); e.currentTarget.classList.remove("dragover");
      const id = e.dataTransfer.getData("application/x-cascade-reference");
      if (id) { onMove(id, category.id || undefined); return; }
      for (const file of Array.from(e.dataTransfer.files)) {
        if (!file.type.startsWith("image/")) continue;
        const reader = new FileReader();
        reader.onload = () => { if (typeof reader.result === "string") onAddReference(file.name.replace(/\.[^.]+$/, ""), category.id || undefined, reader.result); };
        reader.readAsDataURL(file);
      }
    }}>
      <div className="prod-category-head">
        <button className="prod-category-toggle" onClick={() => setCollapsed(!collapsed)} aria-expanded={open} title={open ? "Collapse category" : "Expand category"}>
          <span className={"prod-caret" + (open ? " open" : "")}>▸</span>
        </button>
        <input className="prod-category-name" value={category.name} disabled={!category.id} onChange={(e) => onRenameCategory(category.id, e.target.value)} />
        <span className="hint">{items.length}</span>
      </div>
      {open && (
        <div className="prod-ref-grid">
          {items.map((r) => (
            <RefFigure key={r.id} prodId={prodId} refItem={r} onAttach={onAttach} onRemove={onRemove} onRename={onRename} />
          ))}
          {!items.length && <span className="hint">Drop references here.</span>}
        </div>
      )}
    </section>
  );
}

function RefFigure({ prodId, refItem, onAttach, onRemove, onRename }: {
  prodId: string;
  refItem: CustomRef;
  onAttach: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const r = refItem;
  const imgUrl = r.imagePath ? cascadeMedia(prodId, r.imagePath) : r.artwork;
  const isVideo = r.media === "video" && !!r.mediaPath;
  const hasImage = !!imgUrl && !isVideo;
  const menu = useExternalImageMenu(() => {
    if (r.imagePath) void window.cascade.openInExternalEditor({ productionId: prodId, relPath: r.imagePath }).catch(() => {});
    else if (r.artwork) void window.cascade.openInExternalEditor({ dataUrl: r.artwork }).catch(() => {});
  });
  return (
    <figure className="prod-ref">
      {imgUrl
        ? <img src={imgUrl} alt={r.name} draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-cascade-reference", r.id); e.dataTransfer.effectAllowed = "copyMove"; }} onContextMenu={hasImage ? menu.onContextMenu : undefined} />
        : isVideo
          ? <video className="prod-ref-video" src={`cascade-media://${prodId}/${encodeURIComponent(r.mediaPath!)}`} muted loop playsInline preload="metadata" onMouseEnter={(e) => { try { e.currentTarget.play(); } catch {} }} onMouseLeave={(e) => { try { e.currentTarget.pause(); } catch {} }} draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-cascade-reference", r.id); e.dataTransfer.effectAllowed = "copyMove"; }} />
          : <div className="prod-ref-blank">＋</div>}
      <figcaption><input className="prod-ref-name prod-ref-edit-name" value={r.name} onChange={(e) => onRename(r.id, e.target.value)} /></figcaption>
      {!imgUrl && !isVideo && <button className="prod-ref-addimg" title="Attach a reference image" onClick={() => void onAttach(r.id)}>＋</button>}
      <button className="prod-ref-del" title="Delete this reference" onClick={() => onRemove(r.id)}>×</button>
      {hasImage && menu.menu}
    </figure>
  );
}

export interface PromptReference {
  id: string;
  name: string;
  artwork: string;
  media?: "video" | "audio";
  mediaPath?: string;
}

/** Three-box prompt editor (Style / Content / Brand) with human-readable
 *  reference tags and an @ autocomplete menu on the content box. */

export function promptRefsForShot(prod: Production, shotId: string): PromptReference[] {
  const img = (r: { artwork?: string; imagePath?: string }) => r.imagePath ? cascadeMedia(prod.meta.id, r.imagePath) : r.artwork ?? "";
  return [
    ...prod.characters.filter((r) => r.name && (r.artwork || r.imagePath)).map((r) => ({ id: r.id, name: r.name, artwork: img(r) })),
    ...prod.products.filter((r) => r.name && (r.artwork || r.imagePath)).map((r) => ({ id: r.id, name: r.name, artwork: img(r) })),
    ...(prod.references ?? []).filter((r) => r.name && (r.artwork || r.imagePath || r.media)).map((r) => ({ id: r.id, name: r.name, artwork: img(r), media: r.media, mediaPath: r.mediaPath })),
  ];
}

/** The generated brand clause (palette + font) — mirrors brandPrompt() in
 *  pipeline.ts so the renderer can insert it into manual prompts on toggle. */

export function brandClause(prod: Production): string {
  const colors = (prod.brand?.colors ?? [])
    .map((c) => String(c).trim().replace(/^#/, ""))
    .filter((c) => /^[0-9a-fA-F]{3,6}$/.test(c))
    .slice(0, 5)
    .map((c) => `#${c.toLowerCase()}`);
  const font = (prod.brand?.font ?? "").trim();
  const parts: string[] = [];
  if (colors.length) parts.push(`Color palette: ${colors.join(", ")}.`);
  if (font) parts.push(`Font: ${font}.`);
  return parts.join(" ");
}

/** Select value for a shot's style dropdown: "" = None (manual prompt with
 *  no Style section), otherwise the shot's style or the master fallback. */

export function shotStyleSelectValue(shot: ProductionShot, prod: Production): string {
  if (shot.styleNone) return "";
  if (!shot.style && shot.promptManual && shot.prompt && !/^Style:/m.test(shot.prompt)) return "";
  return shot.style ?? prod.styles?.[0]?.id ?? "";
}

/** Small glyph for media references that have no image thumbnail. */

export function RefMediaGlyph({ media }: { media?: "video" | "audio" }) {
  return <span className="prod-ref-chip-ico">{media === "audio" ? "♪" : "▶"}</span>;
}



