/**
 * On-demand vision tools — the model's eyes.
 *
 * Per the design: images are NEVER pushed into the model's context
 * automatically. The model decides what to look at by calling `view_image`
 * (any workspace image: a generated frame/clip still, an uploaded reference, a
 * saved MCP image) or `capture_screen` (the primary display). Each returns the
 * bytes as `modelImages`, which the core loop attaches as a synthetic user turn
 * — only for a vision-capable model.
 *
 * Deep module: the `VisionHost` seam is the test surface (capture, save, and
 * image encoding are injected). Path handling is confined with the core's
 * `resolveSafe`, exactly like the file tools.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSafe, type AgentTool } from "@core";

/** Extensions `view_image` accepts, mapped to their MIME type. */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

/** Reject absurdly large files before reading them into memory. */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

/** Workspace subfolder captures are written to (matches the MCP image dir). */
export const CAPTURE_DIR = "cascade-images";

export interface VisionHost {
  /** Full-resolution PNG data URL of the primary display. */
  captureDisplay(): Promise<string>;
  /** Persist a captured PNG under `<workspaceRoot>/cascade-images/`; returns the workspace-relative path. */
  saveCapture(dataUrl: string, workspaceRoot: string): string;
  /** Downscale + encode image bytes into a model-facing data URL (nativeImage in prod). */
  toModelImage(bytes: Buffer, mime: string): string;
}

/** The MIME type for a path's extension, or null when it isn't an image. */
export function imageMimeForPath(p: string): string | null {
  return IMAGE_MIME[path.extname(p).toLowerCase()] ?? null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Build the vision tools. `capture` adds `capture_screen` (a privacy-sensitive,
 * approval-gated action); `view_image` is always present. The caller adds the
 * result to `extraTools` only for a vision-capable model.
 */
export function makeVisionTools(host: VisionHost, opts: { capture: boolean }): Record<string, AgentTool> {
  const tools: Record<string, AgentTool> = {};

  tools.view_image = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "view_image",
        description:
          "Look at an image file so you can judge it — a generated storyboard frame or video still, a reference/character sheet, a saved MCP image, or a screenshot. Pass a path relative to your working folder (productions expose each shot's frame path in their digest). Use this to check a generation for character consistency, artifacts, or composition and decide whether to regenerate. Look at images selectively; the ones you view stay in the conversation.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Image path relative to the working folder (e.g. boards/0100/shot-0100.png).",
            },
          },
          required: ["path"],
        },
      },
    },
    run: async (args, root) => {
      const rel = typeof args.path === "string" ? args.path.trim() : "";
      if (!rel) return { text: "ERROR: `path` is required." };
      let abs: string;
      try {
        abs = resolveSafe(root, rel, { mustExist: true });
      } catch (e) {
        return { text: `ERROR: ${errText(e)}` };
      }
      const mime = imageMimeForPath(abs);
      if (!mime) {
        return { text: `ERROR: ${rel} is not a supported image (png, jpg, jpeg, webp, gif, bmp).` };
      }
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(abs);
      } catch (e) {
        return { text: `ERROR: could not read ${rel}: ${errText(e)}` };
      }
      if (bytes.length === 0) return { text: `ERROR: ${rel} is empty.` };
      if (bytes.length > MAX_IMAGE_BYTES) {
        return { text: `ERROR: ${rel} is too large (${Math.round(bytes.length / 1048576)} MB).` };
      }
      let url: string;
      try {
        url = host.toModelImage(bytes, mime);
      } catch (e) {
        return { text: `ERROR: could not decode ${rel}: ${errText(e)}` };
      }
      return { text: `Loaded ${path.basename(abs)} for inspection.`, images: [url], modelImages: [url] };
    },
  };

  if (opts.capture) {
    tools.capture_screen = {
      requiresApproval: true,
      definition: {
        type: "function",
        function: {
          name: "capture_screen",
          description:
            "Take a screenshot of the user's primary display and look at it. Use it to check on-screen progress or read something only visible on screen. The screenshot is saved into your working folder so you can view it again later. Ask sparingly.",
          parameters: { type: "object", properties: {} },
        },
      },
      describe: () => ({
        tool: "capture_screen",
        summary: "Capture the screen",
        detail: "Cascade wants to take a screenshot of your primary display to review its work.",
      }),
      run: async (_args, root) => {
        let png: string;
        try {
          png = await host.captureDisplay();
        } catch (e) {
          return { text: `ERROR: screen capture failed: ${errText(e)}` };
        }
        let rel: string;
        try {
          rel = host.saveCapture(png, root);
        } catch (e) {
          return { text: `ERROR: could not save the screenshot: ${errText(e)}` };
        }
        const b64 = png.slice(png.indexOf(",") + 1);
        let url: string;
        try {
          url = host.toModelImage(Buffer.from(b64, "base64"), "image/png");
        } catch {
          url = png;
        }
        return { text: `Captured the primary display to ${rel}.`, images: [url], modelImages: [url] };
      },
    };
  }

  return tools;
}
