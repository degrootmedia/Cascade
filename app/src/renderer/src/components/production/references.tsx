import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ChangeEvent, DragEvent } from "react";
import type { CharacterSheet, CharacterSheetGenOptions, CharacterSheetView, CliModelSchema, CustomRef, GenParams, ImageGenAspectRatio, OpenArtModelChoice, Production, ProductionShot, ReferenceCategory, ReferenceImageGenOptions } from "../../../../shared/ipc.js";
import { DEFAULT_ASPECT_RATIO, isImageModel, resolveAspectRatio } from "../../../../shared/ipc.js";
import { getMediaDefault, rememberMediaDefault, rememberedModel } from "./media-defaults.js";
import { seedModelOptionValues } from "./model-param-defaults.js";
import { cascadeMedia } from "./animatic.js";
import { ReferencePromptEditor } from "./prompt-panel.js";
import { EditIcon, FilmStripIcon, ImportIcon, MagnifyIcon, PlusIcon, RegenerateIcon, XIcon } from "../icons.js";
import { useImageContextMenu } from "../image-context-menu.js";
import { usePersistedCollapsed } from "./persisted-state.js";
import { ModelOptionsForm, pruneModelOptionValues, type ModelOptionValues } from "../ModelOptionsForm.js";

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
  // Perf 1.5: derive the split lists once per items identity, not per render.
  const withArt = useMemo(() => items.filter((i) => i.artwork), [items]);
  const withoutArt = useMemo(() => items.filter((i) => !i.artwork), [items]);
  const submit = useCallback(() => {
    if (!addName.trim()) return;
    onAdd(addName, addKey);
    setAddName(""); setAddKey(""); setAdding(false);
  }, [addName, addKey, onAdd]);
  return (
    <div className="prod-refs">
      <label className="prod-label">{title}</label>
      {withArt.length > 0 && (
        <div className="prod-ref-grid">
          {withArt.map((i) => (
            <figure key={i.id} className="prod-ref">
              <img src={i.artwork} alt={i.name} />
              <div className="prod-ref-actions">
                <button className="prod-ref-remove" title="Remove this reference" onClick={() => onRemove(i.id)}><XIcon size={12} /></button>
              </div>
              <figcaption>{i.name}</figcaption>
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
            <button className="prod-btn" onClick={() => setAdding(true)}><PlusIcon size={14} /> Add {addKind}…</button>
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
            <div className="prod-ref-actions">
              {i.artwork
                ? <button className="prod-ref-remove" title="Remove reference image" onClick={() => onRemoveImage(i.id)}><XIcon size={12} /></button>
                : <button className="prod-ref-addimg" title="Import a reference image" onClick={() => void onAttach(i.id)}><ImportIcon size={12} /></button>}
              <button className="prod-ref-del" title="Delete this reference" onClick={() => onRemove(i.id)}><XIcon size={12} /></button>
            </div>
          </figure>
        ))}
      </div>
      <div className="prod-ref-new form">
        <input className="prod-ref-new-name" placeholder="Reference name (e.g. Gondola Interior)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="prod-btn" disabled={!name.trim()} onClick={submit}><PlusIcon size={14} /> Add reference…</button>
      </div>
    </div>
  );
}

export function ReferenceCategorySection({ prodId, categories, items, onAddCategory, onRenameCategory, onAddReference, onAttach, onRemove, onRename, onMove, onGenerate, onEditRef, onRescan }: {
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
  /** Open the reference-image generation modal targeting a category. */
  onGenerate: (categoryId?: string) => void;
  onEditRef?: (ref: CustomRef) => void;
  /** Rescan the production's references folder: adopt images added externally. */
  onRescan: () => Promise<void> | void;
}) {
  const [categoryName, setCategoryName] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [rescanning, setRescanning] = useState(false);
  const rescan = useCallback(async () => {
    if (rescanning) return;
    setRescanning(true);
    try { await onRescan(); } finally { setRescanning(false); }
  }, [rescanning, onRescan]);
  const add = useCallback(() => { if (name.trim()) { onAddReference(name, categoryId || undefined); setName(""); } }, [name, categoryId, onAddReference]);
  // Perf 1.5: stable group list per categories identity; per-category item
  // slices are memoized below so a rename keystroke doesn't rebuild them.
  const groups = useMemo(() => [{ id: "", name: "Uncategorized" }, ...categories], [categories]);
  const itemsByCategory = useMemo(() => {
    const map = new Map<string, CustomRef[]>();
    for (const g of groups) map.set(g.id, []);
    for (const r of items) {
      const key = r.categoryId ?? "";
      const list = map.get(key) ?? map.get("")!;
      list.push(r);
    }
    return map;
  }, [groups, items]);
  return (
    <div className="prod-refs">
      <label className="prod-label">Reference images</label>
      <p className="hint">Create categories for your references, then drag images between them. Paste an image (Ctrl+V) to create a reference — drag a reference onto <em>From image</em> to generate a style.</p>
      <div className="prod-category-new">
        <input className="prod-ref-new-name" value={categoryName} placeholder="New category name" onChange={(e) => setCategoryName(e.target.value)} />
        <button className="prod-btn" disabled={!categoryName.trim()} onClick={() => { onAddCategory(categoryName); setCategoryName(""); }}><PlusIcon size={14} /> Add category</button>
        <button className="prod-btn ghost" disabled={rescanning} onClick={() => void rescan()} title="Rescan the production's references folder and adopt images added outside the app">
          <RegenerateIcon size={14} /> {rescanning ? "Scanning…" : "Rescan folder"}
        </button>
      </div>
<div className="prod-category-list">
        {groups.map((category) => (
          <CategoryPanel key={category.id || "uncategorized"} prodId={prodId} category={category} items={itemsByCategory.get(category.id) ?? []} onAddReference={onAddReference} onAttach={onAttach} onRemove={onRemove} onRename={onRename} onRenameCategory={onRenameCategory} onMove={onMove} onGenerate={onGenerate} onEditRef={onEditRef} />
        ))}
      </div>
      <div className="prod-ref-new form">
        <input className="prod-ref-new-name" placeholder="Reference name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="prod-openart-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Uncategorized</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="prod-btn" disabled={!name.trim()} onClick={add}><PlusIcon size={14} /> Add reference</button>
      </div>
    </div>
  );
}


/** One collapsible category panel in the reference grid. Drop targets accept
 *  existing references (move) or pasted/dropped image files (create).
 *
 *  Perf 1.5: memoized with a data-only comparator — the parent passes fresh
 *  inline callbacks every render, so function identity is ignored and only
 *  prodId + category fields + per-item data decide re-render. */
const CategoryPanel = memo(function CategoryPanel({ prodId, category, items, onAddReference, onAttach, onRemove, onRename, onRenameCategory, onMove, onGenerate, onEditRef }: {
  prodId: string;
  category: ReferenceCategory;
  items: CustomRef[];
  onAddReference: (name: string, categoryId?: string, artwork?: string) => void;
  onAttach: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRenameCategory: (id: string, name: string) => void;
  onMove: (id: string, categoryId?: string) => void;
  /** Open the reference-image generation modal targeting this category. */
  onGenerate: (categoryId?: string) => void;
  onEditRef?: (ref: CustomRef) => void;
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
        <button className="prod-ref-gen-btn" title={`Generate a new reference image into "${category.name}"`} onClick={() => onGenerate(category.id || undefined)}>✨</button>
        <span className="hint">{items.length}</span>
      </div>
      {open && (
        <div className="prod-ref-grid">
          {items.map((r) => (
            <RefFigure key={r.id} prodId={prodId} refItem={r} onAttach={onAttach} onRemove={onRemove} onRename={onRename} onEditRef={onEditRef} />
          ))}
          {!items.length && <span className="hint">Drop references here.</span>}
        </div>
      )}
    </section>
  );
}, areCategoryPanelsEqual);

/** Data-only equality for a category panel: function identities are ignored
 *  (the parent recreates them per render); only visible data matters. */
function areCategoryPanelsEqual(
  prev: { prodId: string; category: ReferenceCategory; items: CustomRef[] },
  next: { prodId: string; category: ReferenceCategory; items: CustomRef[] },
): boolean {
  if (prev.prodId !== next.prodId) return false;
  if (prev.category.id !== next.category.id || prev.category.name !== next.category.name) return false;
  return areRefItemListsEqual(prev.items, next.items);
}

function areRefItemListsEqual(a: CustomRef[], b: CustomRef[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!areRefItemsEqual(a[i], b[i])) return false;
  }
  return true;
}

function areRefItemsEqual(a: CustomRef, b: CustomRef): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    (a.imagePath ?? null) === (b.imagePath ?? null) &&
    (a.artwork ?? null) === (b.artwork ?? null) &&
    (a.media ?? null) === (b.media ?? null) &&
    (a.mediaPath ?? null) === (b.mediaPath ?? null) &&
    (a.categoryId ?? "") === (b.categoryId ?? "")
  );
}

/** Perf 1.5 + 2.4: one reference tile. Memoized on data (never on callback
 *  identity) so a rename keystroke re-renders O(1) tile, not O(all). Zoom is
 *  fully local state so it never bubbles to the parent. `contentVisibility`
 *  bounds off-screen layout cost without a virtualization dependency, and
 *  video refs lazy-mount (poster glyph until hover/expand) so N videos don't
 *  open N media elements + metadata loads. */
const RefFigure = memo(function RefFigure({ prodId, refItem, onAttach, onRemove, onRename, onEditRef }: {
  prodId: string;
  refItem: CustomRef;
  onAttach: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onEditRef?: (ref: CustomRef) => void;
}) {
  const r = refItem;
  const imgUrl = r.imagePath ? cascadeMedia(prodId, r.imagePath) : r.artwork;
  const isVideo = r.media === "video" && !!r.mediaPath;
  const hasImage = !!imgUrl && !isVideo;
  const [zoom, setZoom] = useState<{ name: string; url: string } | null>(null);
  // Perf 2.4: video element mounts only on first hover/expand; before that a
  // static glyph stands in (no metadata fetch storm for large libraries).
  const [videoActive, setVideoActive] = useState(false);
  const activateVideo = useCallback(() => setVideoActive(true), []);
  const menu = useImageContextMenu({
    src: imgUrl ?? undefined,
    productionId: r.imagePath ? prodId : undefined,
    relPath: r.imagePath ?? undefined,
    dataUrl: r.imagePath ? undefined : (r.artwork ?? undefined),
  });
  const handleZoom = useCallback(() => setZoom({ name: r.name, url: imgUrl! }), [r.name, imgUrl]);
  const handleCloseZoom = useCallback(() => setZoom(null), []);
  const handleAttach = useCallback(() => void onAttach(r.id), [onAttach, r.id]);
  const handleRemove = useCallback(() => onRemove(r.id), [onRemove, r.id]);
  const handleRename = useCallback((e: ChangeEvent<HTMLInputElement>) => onRename(r.id, e.target.value), [onRename, r.id]);
  const handleEditRef = useCallback(() => onEditRef?.(r), [onEditRef, r]);
  const handleDragStart = useCallback((e: DragEvent) => { e.dataTransfer.setData("application/x-cascade-reference", r.id); e.dataTransfer.effectAllowed = "copyMove"; }, [r.id]);
  return (
    <figure className="prod-ref" style={{ contentVisibility: "auto", containIntrinsicSize: "220px 240px" }}>
      {imgUrl
        ? <img src={imgUrl} alt={r.name} draggable onDragStart={handleDragStart} onContextMenu={hasImage ? menu.onContextMenu : undefined} />
        : isVideo
          ? (videoActive
            ? <video className="prod-ref-video" src={`cascade-media://${prodId}/${encodeURIComponent(r.mediaPath!)}`} muted loop playsInline preload="none" autoPlay onMouseLeave={(e) => { try { e.currentTarget.pause(); } catch {} }} draggable onDragStart={handleDragStart} />
            : <div className="prod-ref-blank" title="Hover to load video preview" onMouseEnter={activateVideo} onClick={activateVideo}><FilmStripIcon size={12} /></div>)
          : <div className="prod-ref-blank">＋</div>}
      <div className="prod-ref-actions">
        {hasImage && <button className="prod-ref-zoom" title="Enlarge this reference" onClick={handleZoom}><MagnifyIcon size={12} /></button>}
        {!imgUrl && !isVideo && <button className="prod-ref-addimg" title="Import a reference image" onClick={handleAttach}><ImportIcon size={12} /></button>}
        {hasImage && onEditRef && <button className="prod-ref-edit-ai" title="Edit this reference image with AI" onClick={handleEditRef}><EditIcon size={12} /></button>}
        <button className="prod-ref-del" title="Delete this reference" onClick={handleRemove}><XIcon size={12} /></button>
      </div>
      <figcaption><input className="prod-ref-name prod-ref-edit-name" value={r.name} onChange={handleRename} /></figcaption>
      {zoom && createPortal(
        <div className="prod-ref-lightbox" onClick={handleCloseZoom}>
          <figure className="prod-ref-lightbox-card">
            <img src={zoom.url} alt={zoom.name} />
            <figcaption>{zoom.name} — click anywhere to close</figcaption>
          </figure>
        </div>, document.body)}
    </figure>
  );
}, (prev, next) =>
  prev.prodId === next.prodId &&
  areRefItemsEqual(prev.refItem, next.refItem) &&
  (prev.onEditRef ? 1 : 0) === (next.onEditRef ? 1 : 0));

export interface PromptReference {
  id: string;
  name: string;
  artwork: string;
  media?: "video" | "audio";
  mediaPath?: string;
}

/** Three-box prompt editor (Style / Content / Brand) with human-readable
 *  reference tags and an @ autocomplete menu on the content box. */

/** Every artwork-bearing reference in the production (characters, products,
 *  custom references), for @ autocomplete and tag previews in prompt editors
 *  that aren't tied to one shot (the reference-image generation modal). */

export function allPromptRefs(prod: Production): PromptReference[] {
  const img = (r: { artwork?: string; imagePath?: string }) => r.imagePath ? cascadeMedia(prod.meta.id, r.imagePath) : r.artwork ?? "";
  // Deduplicate by name (first occurrence wins — characters before products
  // before references): a character and its mirrored "Characters" reference
  // share a name, and the tag must resolve to one entry.
  const out: PromptReference[] = [];
  const seen = new Set<string>();
  const push = (r: PromptReference) => {
    const key = r.name.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };
  for (const r of prod.characters) if (r.name && (r.artwork || r.imagePath)) push({ id: r.id, name: r.name, artwork: img(r) });
  for (const pr of prod.products) if (pr.name && (pr.artwork || pr.imagePath)) push({ id: pr.id, name: pr.name, artwork: img(pr) });
  for (const r of prod.references ?? []) if (r.name && (r.artwork || r.imagePath || r.media)) push({ id: r.id, name: r.name, artwork: img(r), media: r.media, mediaPath: r.mediaPath });
  return out;
}

export function promptRefsForShot(prod: Production, _shotId: string): PromptReference[] {
  return allPromptRefs(prod);
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
  return <span className="prod-ref-chip-ico">{media === "audio" ? "♪" : <FilmStripIcon size={12} />}</span>;
}

/** Step 2 character builder: generate a character-sheet reference image via
 *  OpenArt. The user describes the character; the generation prompt always adds
 *  the sheet framing — full body shot plus a face-closeup inset, front (or
 *  front + back) view, neutral pose/expression/lighting on a plain gray
 *  background (characterSheetPrompt in pipeline.ts). The finished sheet is
 *  attached to the character (created on first build) and shown below. */
export function CharacterBuilderSection({ prodId, characters, models, onGenerate }: {
  prodId: string;
  characters: CharacterSheet[];
  models: OpenArtModelChoice[];
  onGenerate: (opts: CharacterSheetGenOptions) => Promise<void>;
}) {
  const imageModels = models.filter(isImageModel);
  const [characterId, setCharacterId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [view, setView] = useState<CharacterSheetView>("front");
  // Start where the user last left this dropdown (remembered globally across
  // characters and productions).
  const [model, setModel] = useState(() => getMediaDefault("character")?.model ?? imageModels[0]?.id ?? "");
  const [resolution, setResolution] = useState(() => getMediaDefault("character")?.resolution ?? "1k");
  const [busy, setBusy] = useState(false);
  const [refining, setRefining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ name: string; url: string } | null>(null);
  const sheets = characters.filter((c) => c.imagePath || c.artwork);

  const canSubmit = name.trim().length > 0 && description.trim().length > 0;
  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true); setError(null);
    try {
      await onGenerate({ model, resolution, name: name.trim(), description: description.trim(), view });
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
    setBusy(false);
  };
  const refine = async () => {
    if (!description.trim() || refining) return;
    setRefining(true); setError(null);
    try {
      const refined = await window.cascade.refineCharacterDescription(prodId, description.trim());
      setDescription(refined);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
    setRefining(false);
  };
  /** Recall a character's last-used description + generation settings from the
   *  dropdown; "＋ New character…" resets the form to the remembered defaults. */
  const selectCharacter = (id: string) => {
    setCharacterId(id);
    const c = characters.find((x) => x.id === id);
    if (!c) {
      setName("");
      setDescription("");
      setView("front");
      setModel(rememberedModel("character", imageModels.map((m) => m.id), imageModels[0]?.id ?? ""));
      setResolution(getMediaDefault("character")?.resolution ?? "1k");
      return;
    }
    setName(c.name);
    setDescription(c.builder?.description ?? "");
    setView(c.builder?.view ?? "front");
    setModel(c.builder?.model && imageModels.some((m) => m.id === c.builder!.model)
      ? c.builder!.model
      : rememberedModel("character", imageModels.map((m) => m.id), imageModels[0]?.id ?? ""));
    setResolution(c.builder?.resolution ?? getMediaDefault("character")?.resolution ?? "1k");
  };

  return (
    <div className="prod-refs">
      <p className="hint">
        Build a <strong>character reference</strong>: a character sheet with a full body shot and a
        face-closeup inset, in a neutral pose and expression under neutral lighting on a plain gray
        background. Generated sheets attach to the character and carry its look across the storyboard.
      </p>
      <div className="prod-char-form">
        <label className="prod-label">Character name
          <input className="prod-refgen-name" placeholder="e.g. Captain Mara" value={name} onChange={(e) => { setName(e.target.value); if (characterId && characters.find((c) => c.id === characterId)?.name !== e.target.value) setCharacterId(""); }} />
        </label>
        <label className="prod-label">Description</label>
        <div className="prod-char-desc-row">
          <textarea className="prod-refgen-prompt prod-char-desc" rows={4} placeholder="Describe the character — appearance, outfit, distinguishing features…" value={description} onChange={(e) => setDescription(e.target.value)} />
          <button className="prod-btn prod-char-refine" title="Refine this description via the model" disabled={!description.trim() || refining} onClick={() => void refine()}>
            {refining ? "Refining…" : "✨ Refine"}
          </button>
        </div>
        <div className="prod-char-view">
          <span className="prod-label">Sheet views</span>
          <div className="prod-char-view-options">
            <button className={"prod-char-view-opt" + (view === "front" ? " active" : "")} onClick={() => setView("front")}>Front + inset</button>
            <button className={"prod-char-view-opt" + (view === "front-back" ? " active" : "")} onClick={() => setView("front-back")}>Front + back + inset</button>
          </div>
        </div>
        <div className="prod-video-row">
          <label className="prod-label">Model
            <select
              className="prod-openart-select"
              value={imageModels.some((m) => m.id === model) ? model : (imageModels[0]?.id ?? "")}
              onChange={(e) => { setModel(e.target.value); rememberMediaDefault("character", { model: e.target.value }); }}
              title="Image model"
              disabled={imageModels.length === 0}
            >
              {imageModels.map((m) => (
                <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>
              ))}
            </select>
          </label>
          <label className="prod-label">Resolution
            <select className="prod-openart-select" value={resolution} onChange={(e) => { setResolution(e.target.value); rememberMediaDefault("character", { resolution: e.target.value }); }}>
              <option value="1k">1k</option>
              <option value="2k">2k</option>
              <option value="4k">4k</option>
            </select>
          </label>
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="prod-btn" disabled={!canSubmit || busy} onClick={() => void submit()}>
          {busy ? "Generating…" : "＋ Build character sheet"}
        </button>
      </div>
      <div className="prod-char-sheets">
        <label className="prod-label">Character references</label>
        <div className="prod-ref-grid">
          <button className="prod-char-new" title="Start a new character prompt" onClick={() => selectCharacter("")}>＋</button>
          {sheets.map((c) => (
            <figure
              key={c.id}
              className={"prod-ref prod-char-sel" + (c.id === characterId ? " selected" : "")}
              onClick={() => selectCharacter(c.id)}
              title={`Load ${c.name}'s description and generation settings`}
            >
              <img src={c.imagePath ? cascadeMedia(prodId, c.imagePath) : c.artwork} alt={c.name} />
              <div className="prod-ref-actions">
                <button className="prod-ref-zoom" title="Enlarge this character sheet" onClick={(e) => { e.stopPropagation(); setZoom({ name: c.name, url: c.imagePath ? cascadeMedia(prodId, c.imagePath) : c.artwork! }); }}><MagnifyIcon size={12} /></button>
              </div>
              <figcaption>{c.name}</figcaption>
            </figure>
          ))}
        </div>
      </div>
      {zoom && (
        <div className="prod-ref-lightbox" onClick={() => setZoom(null)}>
          <figure className="prod-ref-lightbox-card">
            <img src={zoom.url} alt={zoom.name} />
            <figcaption>{zoom.name} — click anywhere to close</figcaption>
          </figure>
        </div>
      )}
    </div>
  );
}

/** Step 2: generate a new reference image (or AI-edit an existing one) via
 *  OpenArt. Offers a selectable model, resolution and aspect ratio (1:1 / 4:3
 *  / 16:9) plus a prompt; editing reuses a reference's current image as the
 *  visual source. The modal stays open while generating and reports errors
 *  inline; `onSubmit` resolves on success (the caller closes via onClose). */
export function RefGenModal({ prodId, models, editModels, categories, references, promptRefs, defaultCategoryId, initialRefId, onClose, onSubmit }: {
  prodId: string;
  /** Image-generation models (the `image:generate` surface). */
  models: OpenArtModelChoice[];
  /** Image-edit models (the `image:edit` surface) — the Edit tab's pool, so it
   *  matches the classic edit popup / edit node. Falls back to `models`. */
  editModels?: OpenArtModelChoice[];
  categories: ReferenceCategory[];
  references: CustomRef[];
  /** Artwork-bearing references for the prompt box's @ autocomplete + tags. */
  promptRefs: PromptReference[];
  /** Category the generate mode starts in. */
  defaultCategoryId?: string;
  /** Reference to edit — preselects edit mode with this ref as the source. */
  initialRefId?: string;
  onClose: () => void;
  onSubmit: (opts: ReferenceImageGenOptions) => Promise<void>;
}) {
  const generateModels = models.filter(isImageModel);
  const editImageModels = (editModels ?? models).filter(isImageModel);
  const editable = references.filter((r) => r.imagePath || r.artwork);
  const startInEdit = !!initialRefId && editable.some((r) => r.id === initialRefId);
  const [mode, setMode] = useState<"generate" | "edit">(startInEdit ? "edit" : "generate");
  // Each tab has its own model pool and its own remembered choice: Generate
  // rides the "reference" context, Edit rides the "edit" context (the same one
  // the classic edit popup uses).
  const activeModels = mode === "edit" ? editImageModels : generateModels;
  const activeCtx = mode === "edit" ? "edit" : "reference";
  const seedFor = (m: "generate" | "edit"): { model: string; resolution: string; aspectRatio: ImageGenAspectRatio } => {
    const remembered = getMediaDefault(m === "edit" ? "edit" : "reference");
    const ids = (m === "edit" ? editImageModels : generateModels).map((x) => x.id);
    return {
      model: remembered?.model && ids.includes(remembered.model) ? remembered.model : (ids[0] ?? ""),
      resolution: remembered?.resolution ?? "1k",
      aspectRatio: (resolveAspectRatio(remembered?.aspectRatio) as ImageGenAspectRatio) || (DEFAULT_ASPECT_RATIO as ImageGenAspectRatio),
    };
  };
  const initial = seedFor(startInEdit ? "edit" : "generate");
  const [model, setModel] = useState(() => initial.model);
  const [resolution, setResolution] = useState(() => initial.resolution);
  const [aspectRatio, setAspectRatio] = useState<ImageGenAspectRatio>(() => initial.aspectRatio);
  /** Flip tabs, re-seeding the dropdowns from that tab's remembered choice. */
  const switchMode = (next: "generate" | "edit") => {
    if (next === mode) return;
    setMode(next);
    setError(null);
    const seed = seedFor(next);
    setModel(seed.model);
    setResolution(seed.resolution);
    setAspectRatio(seed.aspectRatio);
  };
  const [params, setParams] = useState<GenParams>({});
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  // Advanced/variant options for the picked model (schema-driven). Degrades
  // to nothing when the provider exposes no schema.
  useEffect(() => {
    let live = true;
    setSchema(null);
    if (!model) return () => { live = false; };
    const api = (window as unknown as { cascade?: { modelOptions?: (m: string) => Promise<CliModelSchema | null> } }).cascade;
    if (!api || typeof api.modelOptions !== "function") return () => { live = false; };
    api.modelOptions(model)
      .then((s) => {
        if (!live) return;
        setSchema(s);
        setParams((prev) =>
          seedModelOptionValues(s, model, mode === "edit" ? "image:edit" : "image:generate", pruneModelOptionValues(s, prev)) as GenParams
        );
      })
      .catch(() => { if (live) setSchema(null); });
    return () => { live = false; };
  }, [model]);
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState(defaultCategoryId ?? "");
  const [sourceRefId, setSourceRefId] = useState(
    initialRefId && editable.some((r) => r.id === initialRefId) ? initialRefId : editable[0]?.id ?? ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = editable.find((r) => r.id === sourceRefId);
  const sourceUrl = sourceRef?.imagePath ? cascadeMedia(prodId, sourceRef.imagePath) : sourceRef?.artwork;

  const canSubmit = prompt.trim().length > 0 && (mode === "edit" ? !!sourceRefId : true);
  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true); setError(null);
    try {
      await onSubmit({
        model,
        resolution,
        aspectRatio,
        prompt: prompt.trim(),
        ...(Object.keys(params).length ? { params } : {}),
        ...(mode === "edit"
          ? { sourceRefId }
          : { name: name.trim() || "Generated reference", categoryId: categoryId || undefined }),
      });
      onClose();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
      setBusy(false);
    }
  };

  return (
    <div className="prod-edit-overlay" onClick={onClose}>
      <div className="prod-edit-panel prod-refgen-panel" onClick={(e) => e.stopPropagation()}>
        <div className="prod-edit-head">
          <span className="prod-edit-title">Reference image — generate or edit with AI</span>
          <button className="prod-btn" onClick={onClose}>Cancel</button>
        </div>
        <div className="prod-refgen-tabs">
          <button className={"prod-refgen-tab" + (mode === "generate" ? " active" : "")} onClick={() => switchMode("generate")}>Generate</button>
          <button className={"prod-refgen-tab" + (mode === "edit" ? " active" : "")} disabled={!editable.length} title={editable.length ? "Edit an existing reference image" : "No references with images to edit yet"} onClick={() => switchMode("edit")}>Edit image</button>
        </div>

        <label className="prod-label">Model</label>
        <select
          className="prod-openart-select"
          value={activeModels.some((m) => m.id === model) ? model : (activeModels[0]?.id ?? "")}
          onChange={(e) => { setModel(e.target.value); rememberMediaDefault(activeCtx, { model: e.target.value }); }}
          title={mode === "edit" ? "Image-edit model (same pool as the edit popup and edit node)" : "Image model"}
          disabled={activeModels.length === 0}
        >
          {activeModels.map((m) => (
            <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>
          ))}
        </select>
        {activeModels.length === 0 && (
          <p className="hint">No image models reported — connect the media MCP server.</p>
        )}

        <div className="prod-video-row">
          <label className="prod-label">Resolution
            <select className="prod-openart-select" value={resolution} onChange={(e) => { setResolution(e.target.value); rememberMediaDefault(activeCtx, { resolution: e.target.value }); }}>
              <option value="1k">1k</option>
              <option value="2k">2k</option>
              <option value="4k">4k</option>
            </select>
          </label>
          <label className="prod-label">Aspect ratio
            <select className="prod-openart-select" value={aspectRatio} onChange={(e) => { setAspectRatio(e.target.value as ImageGenAspectRatio); rememberMediaDefault(activeCtx, { aspectRatio: e.target.value }); }}>
              <option value="1:1">1:1</option>
              <option value="4:3">4:3</option>
              <option value="16:9">16:9</option>
            </select>
          </label>
        </div>

        <ModelOptionsForm
          schema={schema}
          value={params as ModelOptionValues}
          onChange={(next) => setParams(next as GenParams)}
          exclude={["resolution", "aspect_ratio"]}
          compact
          persistKey="cascade.modelOptions.advanced.reference"
        />

        {mode === "generate" ? (
          <>
            <label className="prod-label">Name
              <input className="prod-refgen-name" placeholder="e.g. Gondola Interior" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="prod-label">Category
              <select className="prod-openart-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Uncategorized</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </>
        ) : (
          <>
            <label className="prod-label">Reference to edit
              <select className="prod-openart-select" value={sourceRefId} onChange={(e) => setSourceRefId(e.target.value)}>
                {editable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            {sourceUrl && (
              <div className="prod-refgen-source">
                <img src={sourceUrl} alt={sourceRef?.name ?? "source"} />
                <span>The current image is sent as the visual reference.</span>
              </div>
            )}
          </>
        )}

        <label className="prod-label">{mode === "edit" ? "Edit prompt" : "Generation prompt"}</label>
        <ReferencePromptEditor
          className="prod-refgen-prompt"
          rows={7}
          resizable
          value={prompt}
          includeBrand={false}
          references={promptRefs}
          placeholder={mode === "edit" ? 'Describe the edit, e.g. "make it darker, add warm candlelight" — type @ to reuse another reference' : 'Describe the reference image, e.g. "a red velvet gondola interior, cinematic light" — type @ to reuse another reference'}
          onChange={setPrompt}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canSubmit) void submit();
            if (e.key === "Escape") onClose();
          }}
        />
        <p className="hint">
          {mode === "edit"
            ? "The reference's current image is uploaded as the source and replaced when the edit finishes. @ tags add other references as inputs; drag a tag to move it. Ctrl+Enter to submit."
            : "The generated image is added as a new reference in the chosen category. @ tags reuse other references as inputs; drag a tag to move it. Ctrl+Enter to submit."}
        </p>
        {error && <p className="error-text">{error}</p>}
        <button className="prod-btn prod-edit-go" disabled={!canSubmit || busy} onClick={() => void submit()}>
          {busy ? "Generating…" : mode === "edit" ? "Edit reference" : "Generate reference"}
        </button>
      </div>
    </div>
  );
}



