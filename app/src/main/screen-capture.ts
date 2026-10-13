/**
 * Primary-display screenshot seam.
 *
 * Soft-imports Electron's `desktopCapturer` + `screen` (the mcp.ts pattern) so
 * this module still loads in vitest; `captureDeps` is the injectable test seam.
 * `capturePrimaryDisplay` returns a full-resolution PNG data URL of the primary
 * display, bounded to a sane long edge so a 4K screen can't blow up memory.
 */
export interface ScreenSource {
  thumbnail: { toPNG(): Buffer };
}
export interface CaptureDeps {
  getSources: (opts: {
    types: ["screen"];
    thumbnailSize: { width: number; height: number };
  }) => Promise<ScreenSource[]>;
  primaryDisplaySize: () => { width: number; height: number };
}

/** Long-edge cap for the captured PNG (the model sees a <=1024px copy anyway). */
const MAX_CAPTURE_EDGE = 2560;

let electronDeps: CaptureDeps | null = null;
let electronLoaded = false;

async function loadElectronDeps(): Promise<CaptureDeps | null> {
  if (electronLoaded) return electronDeps;
  electronLoaded = true;
  try {
    const m = await import("electron");
    const dc = m.desktopCapturer;
    const screen = m.screen;
    if (dc && screen) {
      electronDeps = {
        getSources: (opts) => dc.getSources(opts) as unknown as Promise<ScreenSource[]>,
        primaryDisplaySize: () => {
          const d = screen.getPrimaryDisplay();
          const f = d.scaleFactor || 1;
          return { width: Math.round(d.size.width * f), height: Math.round(d.size.height * f) };
        },
      };
    }
  } catch {
    electronDeps = null;
  }
  return electronDeps;
}

/** Bound a requested thumbnail size to MAX_CAPTURE_EDGE on its long side. */
export function clampCaptureSize(size: { width: number; height: number }): { width: number; height: number } {
  const edge = Math.max(size.width, size.height) || 1;
  if (edge <= MAX_CAPTURE_EDGE) return size;
  const scale = MAX_CAPTURE_EDGE / edge;
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/**
 * Capture the primary display as a PNG data URL. `deps` is the test seam;
 * production resolves Electron lazily. Throws when capture is unavailable.
 */
export async function capturePrimaryDisplay(deps?: CaptureDeps): Promise<string> {
  const d = deps ?? (await loadElectronDeps());
  if (!d) throw new Error("Screen capture is unavailable (Electron desktopCapturer not found).");
  const size = clampCaptureSize(d.primaryDisplaySize());
  const sources = await d.getSources({ types: ["screen"], thumbnailSize: size });
  if (!sources.length) throw new Error("No screen sources were returned.");
  const png = sources[0].thumbnail.toPNG();
  if (!png || png.length === 0) throw new Error("The screen capture was empty.");
  return `data:image/png;base64,${png.toString("base64")}`;
}
