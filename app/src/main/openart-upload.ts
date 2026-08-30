/**
 * Native OpenArt reference uploader.
 *
 * The OpenArt MCP server's upload widget (`openart_upload_pick`) can't mount
 * in this desktop host — the interactive picker never appears. This module
 * provides a native replacement: it opens a real OS file dialog, reads the
 * chosen file, asks OpenArt for a signed upload URL (via the connected MCP
 * server), PUTs the bytes, and returns a ready `visualReference` the model can
 * pass to `openart_generate_image` / `openart_generate_video`.
 *
 * The native picker itself is the explicit human consent step, so this tool
 * does not also need the approval gate.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { dialog, type BrowserWindow } from "electron";
import type { AgentTool } from "@core";
import type { McpManager } from "./mcp.js";
import { parseJsonLooseObject } from "../shared/prompt-grammar.js";

/** The MCP server name that hosts the OpenArt tools (matches mcp.json). */
const SERVER = "openart";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".m4v": "video/mp4",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

function mediaTypeOf(contentType: string): "image" | "video" | "audio" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return "audio";
}

const DIALOG_FILTERS = [
  { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] },
  { name: "Video", extensions: ["mp4", "webm", "mov", "mkv", "m4v", "avi"] },
  { name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac"] },
  { name: "All files", extensions: ["*"] },
];

/** A data-URL reference image uploaded to OpenArt as a ready visualReference. */
export interface UploadedRef {
  name: string;
  visualReference: Record<string, unknown>;
}

/**
 * Upload a data-URL image (e.g. a Step 2 reference artwork) to OpenArt and
 * return a ready `visualReference` to pass to the generate tool. Identity is
 * the SHA-256 of the data URL, so identical artwork uploads are deduped.
 * Mirrors the sign+PUT flow used by the native picker, but feeding an
 * already-in-memory data URL rather than a file dialog.
 */
const refUploadCache = new Map<string, Record<string, unknown>>();

export async function uploadDataUrlReference(
  mcp: McpManager,
  dataUrl: string,
  label: string,
  purpose: "create-image" | "create-video" = "create-image"
): Promise<Record<string, unknown>> {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new Error("Not a base64 data-URL image.");
  const contentType = m[1];
  const b64 = m[2];
  const cached = refUploadCache.get(dataUrl);
  if (cached) return cached;

  const mediaType = mediaTypeOf(contentType);
  const size = Math.ceil((b64.length * 3) / 4); // decoded byte length (base64 ≈ 4/3)
  const signText = await mcp.callRaw(SERVER, "openart_upload_sign", {
    filename: `${path.basename(label).replace(/\.[^.]+$/, "") || "ref"}.png`,
    size,
    contentType,
    mediaType,
    purpose,
  });
  const sign = parseJsonLooseObject(signText);
  const signURL = sign?.signURL as string | undefined;
  if (!signURL) throw new Error(`OpenArt did not return a signed URL: ${signText.slice(0, 300)}`);

  const body = Buffer.from(b64, "base64");
  try {
    const put = await fetch(signURL, {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(body.length) },
      body,
    });
    if (!put.ok && ![200, 201, 308].includes(put.status)) {
      throw new Error(`upload to OpenArt failed (HTTP ${put.status})`);
    }
  } catch (e) {
    throw new Error(`upload to OpenArt failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const vr = (sign?.visualReference as object | undefined) ?? {
    type: mediaType,
    url: sign?.accessURL as string | undefined,
    label,
  };
  refUploadCache.set(dataUrl, vr as Record<string, unknown>);
  return vr as Record<string, unknown>;
}

export function makeOpenArtUploadTool(
  win: BrowserWindow | null,
  mcp: McpManager,
  onMention?: (dataUrl: string, filename: string) => void
): AgentTool {
  const upload = async (args: Record<string, unknown>): Promise<string> => {
    const purpose = args.purpose === "create-video" ? "create-video" : "create-image";

    const res = await dialog.showOpenDialog(win!, {
      title: "Select a reference file to upload to OpenArt",
      properties: ["openFile"],
      filters: DIALOG_FILTERS,
    });
    if (res.canceled || !res.filePaths[0]) {
      return "CANCELLED: no file was selected. Ask the user whether they still want to continue without a reference.";
    }

    const filePath = res.filePaths[0];
    const filename = path.basename(filePath);
    const contentType = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
    if (!contentType) {
      return "ERROR: unsupported file type. Ask the user to choose an image, video, or audio file.";
    }
    const mediaType = mediaTypeOf(contentType);
    const size = fs.statSync(filePath).size;

    let signText: string;
    try {
      signText = await mcp.callRaw(SERVER, "openart_upload_sign", {
        filename,
        size,
        contentType,
        mediaType,
        purpose,
      });
    } catch (e) {
      return `ERROR: couldn't get an OpenArt upload URL: ${e instanceof Error ? e.message : String(e)}`;
    }

    const sign = parseJsonLooseObject(signText);
    const signURL = sign?.signURL as string | undefined;
    if (!signURL) return `ERROR: OpenArt did not return a signed URL. Response: ${signText.slice(0, 500)}`;

    // Resumable GCS: a single PUT with the full body and correct headers is
    // the final chunk and returns 200/201. Reading into memory is fine for
    // typical reference media.
    try {
      const put = await fetch(signURL, {
        method: "PUT",
        headers: { "Content-Type": contentType, "Content-Length": String(size) },
        body: fs.readFileSync(filePath),
      });
      if (!put.ok && ![200, 201, 308].includes(put.status)) {
        const body = (await put.text().catch(() => "")).slice(0, 300);
        return `ERROR: upload to OpenArt failed (HTTP ${put.status})${body ? `: ${body}` : ""}`;
      }
    } catch (e) {
      return `ERROR: upload to OpenArt failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    const vr = (sign?.visualReference as object | undefined) ?? {
      type: mediaType,
      url: sign?.accessURL as string | undefined,
      label: filename,
    };

    // Surface the picked file in the chat (and persist it with the session)
    // so the OpenArt upload is recorded in chat history.
    try {
      const dataUrl = `data:${contentType};base64,${fs.readFileSync(filePath).toString("base64")}`;
      onMention?.(dataUrl, filename);
    } catch {
      /* mention is best-effort; the upload itself still succeeded */
    }

    const kb = (size / 1024).toFixed(1);
    return (
      `Uploaded "${filename}" (${kb} KB, ${mediaType}) to OpenArt. ` +
      `Pass this as params.visualReferences (an array) on openart_generate_image / openart_generate_video:\n` +
      JSON.stringify({ visualReference: vr }, null, 2)
    );
  };

  return {
    requiresApproval: false, // the native picker is the explicit consent
    definition: {
      type: "function",
      function: {
        name: "openart_upload_reference",
        description:
          "[OpenArt native] Open a system file dialog so the user can pick a LOCAL reference image/video/audio file, upload it to OpenArt, and return a ready visualReference to pass to openart_generate_image / openart_generate_video. Prefer this over openart__openart_upload_pick if you were about to call that (the widget is unavailable in this desktop host). Call it whenever the user supplies — or should supply — their own reference media for image/video generation and no suitable reference is already uploaded.",
        parameters: {
          type: "object",
          properties: {
            purpose: {
              type: "string",
              enum: ["create-image", "create-video"],
              description: "What the upload is for. Defaults to create-image.",
            },
          },
        },
      },
    },
    run: async (args) => upload((args ?? {}) as Record<string, unknown>),
  };
}
