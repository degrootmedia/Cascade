/** Full-color icon set — thin `<img>` wrappers over the SVGs in
 *  `assets/icons/` (bundled by Vite as static assets). Keeps the hard-coded
 *  brand colors from the source art; sizing is controlled at the call site
 *  (`size` or `className`), so these stay small and consistent everywhere. */
import attachFileUrl from "../assets/icons/attach-file.svg";
import dragHandleUrl from "../assets/icons/drag-handle.svg";
import editUrl from "../assets/icons/Edit.svg";
import expensesUrl from "../assets/icons/expenses.svg";
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
import xUrl from "../assets/icons/X.svg";

interface IconProps {
  /** Pixel box size — default 16. */
  size?: number;
  className?: string;
  title?: string;
}

function Icon({ src, size = 16, className, title, alt = "" }: { src: string } & IconProps & { alt?: string }) {
  return (
    <img
      src={src}
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

/** Red X — close / remove. */
export const XIcon = (p: IconProps) => <Icon src={xUrl} {...p} />;
/** Gold coin — AI credit / token cost. */
export const TokenIcon = (p: IconProps) => <Icon src={tokenUrl} {...p} />;
/** Red stop square — stop generation / playback. */
export const StopButtonIcon = (p: IconProps) => <Icon src={stopButtonUrl} {...p} />;
/** Amber circular arrows — regenerate / retry. */
export const RegenerateIcon = (p: IconProps) => <Icon src={regenerateUrl} {...p} />;
/** Green plus — add. */
export const PlusIcon = (p: IconProps) => <Icon src={plusUrl} {...p} />;
/** Red play triangle — play. */
export const PlayButtonIcon = (p: IconProps) => <Icon src={playButtonUrl} {...p} />;
/** Blue node diagram — the per-shot node graph. */
export const NodesIcon = (p: IconProps) => <Icon src={nodesUrl} {...p} />;
/** Blue magnifier — search / zoom. */
export const MagnifyIcon = (p: IconProps) => <Icon src={magnifyUrl} {...p} />;
/** Search lens — the sidebar chat search bar. */
export const SearchIcon = (p: IconProps) => <Icon src={searchUrl} {...p} />;
/** Six-dot grip — drag to reorder. */
export const DragHandleIcon = (p: IconProps) => <Icon src={dragHandleUrl} {...p} />;
/** Blue arrow into a container — insert before. */
export const InsertIcon = (p: IconProps) => <Icon src={insertUrl} {...p} />;
/** Blue download/import arrow — import a file. */
export const ImportIcon = (p: IconProps) => <Icon src={importUrl} {...p} />;
/** Blue/green interpolation arrows — in-betweener node. */
export const InbetweenIcon = (p: IconProps) => <Icon src={inbetweenUrl} {...p} />;
/** Film strip — animatic / video timeline. */
export const FilmStripIcon = (p: IconProps) => <Icon src={filmStripUrl} {...p} />;
/** Wallet/receipt — expenses ledger. */
export const ExpensesIcon = (p: IconProps) => <Icon src={expensesUrl} {...p} />;
/** Red pencil — edit. */
export const EditIcon = (p: IconProps) => <Icon src={editUrl} {...p} />;
/** Blue paperclip — attach a file. */
export const AttachFileIcon = (p: IconProps) => <Icon src={attachFileUrl} {...p} />;
/** Photo frame — image input / from-image actions. */
export const ImageIcon = (p: IconProps) => <Icon src={imageUrl} {...p} />;
/** Golden magic wand/sparkle — AI magic / refine prompts. */
export const MagicIcon = (p: IconProps) => <Icon src={magicUrl} {...p} />;