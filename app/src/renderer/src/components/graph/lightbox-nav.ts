/** Generation history a node-graph lightbox can step through with the arrow keys. */
export type ZoomNav = { items: { url: string; path: string }[]; index: number };

export function stepLightbox<T extends { artwork: string; rel?: string; nav?: ZoomNav }>(lb: T, dir: -1 | 1): T {
  const nav = lb.nav;
  if (!nav || nav.items.length < 2) return lb;
  const index = (nav.index + dir + nav.items.length) % nav.items.length;
  const it = nav.items[index];
  return { ...lb, artwork: it.url, rel: it.path, nav: { ...nav, index } };
}
