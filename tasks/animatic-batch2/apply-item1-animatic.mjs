/**
 * Item 1 edits to animatic.tsx (CRLF-safe: operates on raw text,
 * preserves line endings). Each guard must match exactly once.
 */
import * as fs from "node:fs";
const p = "app/src/renderer/src/components/production/animatic.tsx";
let s = fs.readFileSync(p, "utf8");
const E = s.includes("\r\n") ? "\r\n" : "\n";
const J = (lines) => lines.join(E);
function rep(find, replace, label) {
  const n = s.split(find).length - 1;
  if (n !== 1) { console.log(`FAIL ${label}: ${n} matches`); process.exit(1); }
  s = s.replace(find, replace);
  console.log(`ok ${label}`);
}

// 1. nextBlend preload state.
rep(
  J([
    "  /** Outgoing side of a dissolve covering the active item (Item 8). */",
    "  const activeBlend = activeItem ? timelineOverride?.blendFrom.get(activeItem.id) : undefined;",
  ]),
  J([
    "  /** Outgoing side of a dissolve covering the active item (Item 8). */",
    "  const activeBlend = activeItem ? timelineOverride?.blendFrom.get(activeItem.id) : undefined;",
    "  /** The NEXT item's dissolve, preloaded (hidden, seeked to its first",
    "   *  frame) so the under-layer is already decoded when the blend",
    "   *  starts — mounting it at the blend's first frame left it black",
    "   *  while loading, which read as a dip to black. */",
    "  const nextItem = activeIdx >= 0 ? shots[activeIdx + 1] : undefined;",
    "  const nextBlend = !activeBlend && nextItem ? timelineOverride?.blendFrom.get(nextItem.id) : undefined;",
    "  const underBlend = activeBlend ?? nextBlend;",
  ]),
  "nextBlend state",
);

// 2. Blend effect: drift-only seeks while playing + preload + still top fade.
rep(
  J([
    "    videoElsRef.current.forEach((el, id) => {",
    '      try { el.style.opacity = activeBlend && id === activeId ? String(Math.min(1, Math.max(0, offsetInShot / Math.max(0.0001, activeItem?.durationSec ?? 1)))) : ""; } catch {}',
    "    });",
    "    const bv = blendVideoRef.current;",
    "    if (!activeBlend || !bv) return;",
    "    try {",
    "      if (bv.readyState >= 1 && Number.isFinite(bv.duration) && bv.duration > 0) {",
    "        bv.currentTime = Math.min(Math.max(0, activeBlend.sourceAt(offsetInShot)), bv.duration);",
    "      }",
    "    } catch {}",
  ]),
  J([
    '    const blendOpacity = activeBlend ? String(Math.min(1, Math.max(0, offsetInShot / Math.max(0.0001, activeItem?.durationSec ?? 1)))) : "";',
    "    videoElsRef.current.forEach((el, id) => {",
    "      try { el.style.opacity = activeBlend && id === activeId ? blendOpacity : \"\"; } catch {}",
    "    });",
    "    // Incoming STILL: fade the monitor thumb the same way.",
    "    try {",
    '      const thumb = previewRef.current?.querySelector("img.prod-timeline-thumb") as HTMLImageElement | null;',
    "      if (thumb) thumb.style.opacity = blendOpacity;",
    "    } catch {}",
    "    const bv = blendVideoRef.current;",
    "    if (!bv) return;",
    "    if (!activeBlend) {",
    "      // Preload the upcoming blend's under-layer: park it on the",
    "      // blend's first frame (paused) so activation starts decoded.",
    "      if (nextBlend?.videoPath) {",
    "        try {",
    "          if (bv.readyState >= 1 && Number.isFinite(bv.duration) && bv.duration > 0) {",
    "            const want = Math.min(Math.max(0, nextBlend.sourceAt(0)), bv.duration);",
    "            if (Math.abs(bv.currentTime - want) > 0.1) bv.currentTime = want;",
    "          }",
    "        } catch {}",
    "        try { bv.pause(); } catch {}",
    "      }",
    "      return;",
    "    }",
    "    if (!activeBlend.videoPath) return; // still under-layer: no transport",
    "    try {",
    "      if (bv.readyState >= 1 && Number.isFinite(bv.duration) && bv.duration > 0) {",
    "        // Pin the frame when paused/scrubbing; while playing, seek",
    "        // only on real drift. Seeking every frame starved the",
    "        // decoder (readyState stuck at HAVE_METADATA) so the",
    "        // under-layer painted BLACK and the dissolve dipped to",
    "        // black instead of crossfading.",
    "        const want = Math.min(Math.max(0, activeBlend.sourceAt(offsetInShot)), bv.duration);",
    "        if (!playing || Math.abs(bv.currentTime - want) > 0.4) bv.currentTime = want;",
    "      }",
    "    } catch {}",
  ]),
  "blend effect seek policy",
);
rep(
  "  }, [playhead, activeId, playing, activeBlend, animaticMuted, offsetInShot]);",
  "  }, [playhead, activeId, playing, activeBlend, nextBlend, animaticMuted, offsetInShot]);",
  "blend effect deps",
);

// 3. Under-layer render: active or preloading; video or still.
rep(
  J([
    "        {activeBlend && (",
    "          <video",
    "            key={`blend:${activeBlend.videoPath}`}",
    "            ref={blendVideoRef}",
    '            className="prod-animatic-video blend-under"',
    "            src={`cascade-media://${prodId}/${encodeURIComponent(activeBlend.videoPath)}`}",
    "            muted={!!activeBlend.muted}",
    '            preload="auto"',
    "            playsInline",
    "          />",
    "        )}",
  ]),
  J([
    "        {underBlend?.videoPath && (",
    "          <video",
    "            key={`blend:${underBlend.videoPath}`}",
    "            ref={blendVideoRef}",
    '            className={"prod-animatic-video" + (activeBlend ? " blend-under" : "")}',
    "            src={`cascade-media://${prodId}/${encodeURIComponent(underBlend.videoPath)}`}",
    "            muted={!!underBlend.muted}",
    '            preload="auto"',
    "            playsInline",
    "          />",
    "        )}",
    "        {underBlend?.stillPath && (",
    "          <img",
    "            key={`blend:${underBlend.stillPath}`}",
    '            className={"prod-animatic-video" + (activeBlend ? " blend-under" : "")}',
    "            src={`cascade-media://${prodId}/${encodeURIComponent(underBlend.stillPath)}`}",
    '            alt=""',
    "          />",
    "        )}",
  ]),
  "under layer render",
);

fs.writeFileSync(p, s, "utf8");
console.log("done");
