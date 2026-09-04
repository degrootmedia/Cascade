/** Right-click an image → show the app's single native image menu (Save image
 *  as… / Copy image / Edit externally) via the `image:showMenu` IPC. The menu
 *  is built once in main (`popImageContextMenu`), so every image — chat, board,
 *  reference, node-graph — gets the same three options with the same wording.
 *  `productionId`+`relPath` (or `dataUrl`) pin the full-res "Edit externally"
 *  target when the displayed src is a thumbnail that main can't resolve. */
export function useImageContextMenu(opts: {
  src?: string;
  productionId?: string;
  relPath?: string;
  dataUrl?: string;
}): { onContextMenu: ((e: React.MouseEvent) => void) | undefined } {
  if (!opts.src) return { onContextMenu: undefined };
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void window.cascade.showImageMenu({
        src: opts.src!,
        x: e.clientX,
        y: e.clientY,
        productionId: opts.productionId,
        relPath: opts.relPath,
        dataUrl: opts.dataUrl,
      });
    },
  };
}