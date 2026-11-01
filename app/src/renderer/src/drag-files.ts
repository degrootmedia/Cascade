export function hasDraggedFiles(dt: { types?: ArrayLike<string> } | null | undefined): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}
