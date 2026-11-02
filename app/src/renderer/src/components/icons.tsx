/** Icon sets — every icon exists twice: "colorful" (the original full-color
 *  SVGs in `assets/icons/`, rendered as an `<img>`) and "minimal" (single-color
 *  outline SVGs in `assets/icons/minimal/`, rendered as a CSS mask painted
 *  with the theme's `--icon-tint` — white on dark themes, dark gray on the
 *  light XSI theme). The active set (Settings → Appearance) lives in the
 *  store in theme.ts; components subscribe so a switch re-renders every
 *  mounted icon live. Sizing is controlled at the call site (`size` or
 *  `className`), so these stay small and consistent everywhere. */
import { useSyncExternalStore, type CSSProperties } from "react";
import type { UiIconSet } from "../../../shared/ipc.js";
import { getIconSetSnapshot, subscribeIconSet } from "../theme.js";
import attachFileUrl from "../assets/icons/attach-file.svg";
import dragHandleUrl from "../assets/icons/drag-handle.svg";
import editUrl from "../assets/icons/Edit.svg";
import expensesUrl from "../assets/icons/expenses.svg";
import eyeOffUrl from "../assets/icons/eye-off.svg";
import eyeUrl from "../assets/icons/eye.svg";
import filmStripUrl from "../assets/icons/film-strip.svg";
import imageUrl from "../assets/icons/Image.svg";
import importUrl from "../assets/icons/import.svg";
import inbetweenUrl from "../assets/icons/inbetween.svg";
import insertUrl from "../assets/icons/insert.svg";
import magicUrl from "../assets/icons/magic.svg";
import magnifyUrl from "../assets/icons/Magnify.svg";
import nodesUrl from "../assets/icons/nodes.svg";
import playButtonUrl from "../assets/icons/play-button.svg";
import plusUrl from "../assets/icons/plus.svg";
import regenerateUrl from "../assets/icons/regenerate.svg";
import searchUrl from "../assets/icons/search.svg";
import stopButtonUrl from "../assets/icons/stop-button.svg";
import tokenUrl from "../assets/icons/token.svg";
import trashUrl from "../assets/icons/trash.svg";
import videoEditingUrl from "../assets/icons/video-editing.svg";
import genjutsuMotionUrl from "../assets/icons/genjutsu-motion.svg";
import genjutsuSwapUrl from "../assets/icons/genjutsu-swap.svg";
import xUrl from "../assets/icons/X.svg";
import mAttachFileUrl from "../assets/icons/minimal/attach-file.svg";
import mDragHandleUrl from "../assets/icons/minimal/drag-handle.svg";
import mEditUrl from "../assets/icons/minimal/Edit.svg";
import mExpensesUrl from "../assets/icons/minimal/expenses.svg";
import mEyeOffUrl from "../assets/icons/minimal/eye-off.svg";
import mEyeUrl from "../assets/icons/minimal/eye.svg";
import mFilmStripUrl from "../assets/icons/minimal/film-strip.svg";
import mImageUrl from "../assets/icons/minimal/Image.svg";
import mImportUrl from "../assets/icons/minimal/import.svg";
import mInbetweenUrl from "../assets/icons/minimal/inbetween.svg";
import mInsertUrl from "../assets/icons/minimal/insert.svg";
import mMagicUrl from "../assets/icons/minimal/magic.svg";
import mMagnifyUrl from "../assets/icons/minimal/Magnify.svg";
import mNodesUrl from "../assets/icons/minimal/nodes.svg";
import mPlayButtonUrl from "../assets/icons/minimal/play-button.svg";
import mPlusUrl from "../assets/icons/minimal/plus.svg";
import mRegenerateUrl from "../assets/icons/minimal/regenerate.svg";
import mSearchUrl from "../assets/icons/minimal/search.svg";
import mStopButtonUrl from "../assets/icons/minimal/stop-button.svg";
import mTokenUrl from "../assets/icons/minimal/token.svg";
import mTrashUrl from "../assets/icons/minimal/trash.svg";
import mVideoEditingUrl from "../assets/icons/minimal/video-editing.svg";
import mGenjutsuMotionUrl from "../assets/icons/minimal/genjutsu-motion.svg";
import mGenjutsuSwapUrl from "../assets/icons/minimal/genjutsu-swap.svg";
import mXUrl from "../assets/icons/minimal/X.svg";

interface IconProps {
  /** Pixel box size — default 16. */
  size?: number;
  className?: string;
  title?: string;
  /** Force a set regardless of the user's choice (Appearance previews). */
  iconSet?: UiIconSet;
}

function Icon({
  colorful,
  minimal,
  size = 16,
  className,
  title,
  iconSet,
  alt = "",
}: { colorful: string; minimal: string } & IconProps & { alt?: string }) {
  const active = useSyncExternalStore(subscribeIconSet, getIconSetSnapshot, getIconSetSnapshot);
  const set = iconSet ?? active;
  if (set === "minimal") {
    const style = {
      "--cascade-icon-size": `${size}px`,
      WebkitMaskImage: `url("${minimal}")`,
      maskImage: `url("${minimal}")`,
    } as CSSProperties;
    return (
      <span
        className={"cascade-icon cascade-icon-minimal" + (className ? ` ${className}` : "")}
        style={style}
        title={title}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        aria-hidden={!alt}
      />
    );
  }
  return (
    <img
      src={colorful}
      alt={alt}
      width={size}
      height={size}
      className={"cascade-icon" + (className ? ` ${className}` : "")}
      title={title}
      draggable={false}
      aria-hidden={!alt}
    />
  );
}

/** Close / dismiss a surface (never delete: that's the trashcan). */
export const XIcon = (p: IconProps) => <Icon colorful={xUrl} minimal={mXUrl} {...p} />;
/** Delete / remove a thing (references, shots, rows…). */
export const TrashIcon = (p: IconProps) => <Icon colorful={trashUrl} minimal={mTrashUrl} {...p} />;
/** AI credit / token cost. */
export const TokenIcon = (p: IconProps) => <Icon colorful={tokenUrl} minimal={mTokenUrl} {...p} />;
/** Stop generation / playback. */
export const StopButtonIcon = (p: IconProps) => <Icon colorful={stopButtonUrl} minimal={mStopButtonUrl} {...p} />;
/** Regenerate / retry. */
export const RegenerateIcon = (p: IconProps) => <Icon colorful={regenerateUrl} minimal={mRegenerateUrl} {...p} />;
/** Add. */
export const PlusIcon = (p: IconProps) => <Icon colorful={plusUrl} minimal={mPlusUrl} {...p} />;
/** Play. */
export const PlayButtonIcon = (p: IconProps) => <Icon colorful={playButtonUrl} minimal={mPlayButtonUrl} {...p} />;
/** The per-shot node graph. */
export const NodesIcon = (p: IconProps) => <Icon colorful={nodesUrl} minimal={mNodesUrl} {...p} />;
/** Search / zoom. */
export const MagnifyIcon = (p: IconProps) => <Icon colorful={magnifyUrl} minimal={mMagnifyUrl} {...p} />;
/** Search lens — the sidebar chat search bar. */
export const SearchIcon = (p: IconProps) => <Icon colorful={searchUrl} minimal={mSearchUrl} {...p} />;
/** Six-dot grip — drag to reorder. */
export const DragHandleIcon = (p: IconProps) => <Icon colorful={dragHandleUrl} minimal={mDragHandleUrl} {...p} />;
/** Arrow into a container — insert before. */
export const InsertIcon = (p: IconProps) => <Icon colorful={insertUrl} minimal={mInsertUrl} {...p} />;
/** Download/import arrow — import a file. */
export const ImportIcon = (p: IconProps) => <Icon colorful={importUrl} minimal={mImportUrl} {...p} />;
/** Interpolation arrows — in-betweener node. */
export const InbetweenIcon = (p: IconProps) => <Icon colorful={inbetweenUrl} minimal={mInbetweenUrl} {...p} />;
/** Film strip — animatic / video timeline. */
export const FilmStripIcon = (p: IconProps) => <Icon colorful={filmStripUrl} minimal={mFilmStripUrl} {...p} />;
/** Film frame with a pencil — the edit-video node. */
export const EditVideoIcon = (p: IconProps) => <Icon colorful={videoEditingUrl} minimal={mVideoEditingUrl} {...p} />;
/** Film frame with motion streaks — the Genjutsu Motion Transfer node. */
export const GenjutsuMotionIcon = (p: IconProps) => <Icon colorful={genjutsuMotionUrl} minimal={mGenjutsuMotionUrl} {...p} />;
/** Swap arrows — the Genjutsu Object Swap node. */
export const GenjutsuSwapIcon = (p: IconProps) => <Icon colorful={genjutsuSwapUrl} minimal={mGenjutsuSwapUrl} {...p} />;
/** Wallet — expenses ledger. */
export const ExpensesIcon = (p: IconProps) => <Icon colorful={expensesUrl} minimal={mExpensesUrl} {...p} />;
/** Open eye — show the models hidden from the dropdowns. */
export const EyeIcon = (p: IconProps) => <Icon colorful={eyeUrl} minimal={mEyeUrl} {...p} />;
/** Crossed-out eye — conceal them (visual only). */
export const EyeOffIcon = (p: IconProps) => <Icon colorful={eyeOffUrl} minimal={mEyeOffUrl} {...p} />;
/** Pencil — edit. */
export const EditIcon = (p: IconProps) => <Icon colorful={editUrl} minimal={mEditUrl} {...p} />;
/** Paperclip — attach a file. */
export const AttachFileIcon = (p: IconProps) => <Icon colorful={attachFileUrl} minimal={mAttachFileUrl} {...p} />;
/** Photo frame — image input / from-image actions. */
export const ImageIcon = (p: IconProps) => <Icon colorful={imageUrl} minimal={mImageUrl} {...p} />;
/** Magic wand/sparkle — AI magic / refine prompts. */
export const MagicIcon = (p: IconProps) => <Icon colorful={magicUrl} minimal={mMagicUrl} {...p} />;
