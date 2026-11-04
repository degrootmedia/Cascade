/**
 * Item 4 edits to CRLF files: styles.css, animatic.tsx (preview wrap),
 * ProductionWorkspace.tsx (shared loop state in TimelineSection).
 */
import * as fs from "node:fs";

function patch(p, reps) {
  let s = fs.readFileSync(p, "utf8");
  const E = s.includes("\r\n") ? "\r\n" : "\n";
  const J = (lines) => lines.join(E);
  for (const [find, replace, label] of reps) {
    const f = Array.isArray(find) ? J(find) : find;
    const r = Array.isArray(replace) ? J(replace) : replace;
    const n = s.split(f).length - 1;
    if (n !== 1) { console.log(`FAIL ${p} :: ${label}: ${n} matches`); process.exit(1); }
    s = s.replace(f, r);
    console.log(`ok ${label}`);
  }
  fs.writeFileSync(p, s, "utf8");
}

patch("app/src/renderer/src/styles.css", [
  [
    ".prod-tl-tick { position: absolute; top: 2px; transform: translateX(3px); white-space: nowrap; pointer-events: none; }",
    [
      ".prod-tl-tick { position: absolute; top: 2px; transform: translateX(3px); white-space: nowrap; pointer-events: none; }",
      "/* Loop region (In/Out points): accent wash between the markers. */",
      ".prod-tl-loop-region {",
      "  position: absolute; top: 0; bottom: 0; pointer-events: none;",
      "  background: color-mix(in srgb, var(--accent) 22%, transparent);",
      "  border-left: 1px solid var(--accent); border-right: 1px solid var(--accent);",
      "}",
      ".prod-tl-loop-pt {",
      "  position: absolute; top: 1px; transform: translateX(-50%); pointer-events: none;",
      "  font-size: 9px; font-weight: 700; color: var(--accent);",
      "}",
    ],
    "loop ruler css",
  ],
]);

patch("app/src/renderer/src/components/production/animatic.tsx", [
  [
    'import { blendUnderShouldSeek, type TimelineOverride } from "./timeline-preview.js";',
    'import { blendUnderShouldSeek, loopWrapAt, type TimelineLoopRegion, type TimelineOverride } from "./timeline-preview.js";',
    "animatic imports",
  ],
  [
    "  playheadSec: playhead, onPlayheadChange: setPlayhead, playing, onPlayingChange: setPlaying, onSaveAsReference,",
    "  playheadSec: playhead, onPlayheadChange: setPlayhead, playing, onPlayingChange: setPlaying, onSaveAsReference, loopRegion,",
    "animatic prop destructure",
  ],
  [
    [
      "  /** Copy the previewed shot's generated clip/frame into the production",
      "   *  as a new reference (right-click the preview). */",
      "  onSaveAsReference?: (shotId: string, rel: string) => void;",
    ],
    [
      "  /** Copy the previewed shot's generated clip/frame into the production",
      "   *  as a new reference (right-click the preview). */",
      "  onSaveAsReference?: (shotId: string, rel: string) => void;",
      "  /** Loop In/Out region from the editor below: with Loop on, the",
      "   *  transport wraps from Out back to In instead of playing past. */",
      "  loopRegion?: TimelineLoopRegion;",
    ],
    "animatic prop type",
  ],
  [
    [
      "    const tick = () => {",
      "      if (flag !== stopFlagRef.current) return;",
      "      const h = startedHeadRef.current + (performance.now() / 1000 - startedAtRef.current);",
      "      if (h >= total) { stop(); setPlayhead(0); return; }",
      "      setPlayhead(h);",
      "      rafRef.current = requestAnimationFrame(tick);",
      "    };",
    ],
    [
      "    const tick = () => {",
      "      if (flag !== stopFlagRef.current) return;",
      "      const h = startedHeadRef.current + (performance.now() / 1000 - startedAtRef.current);",
      "      // Loop region: wrap Out -> In and keep playing (re-anchoring",
      "      // the wall clock so the drift-corrected media re-syncs).",
      "      const wrap = loopRegionRef.current ? loopWrapAt(loopRegionRef.current, h) : null;",
      "      if (wrap != null) {",
      "        startedHeadRef.current = wrap;",
      "        startedAtRef.current = performance.now() / 1000;",
      "        setPlayhead(wrap);",
      "        rafRef.current = requestAnimationFrame(tick);",
      "        return;",
      "      }",
      "      if (h >= total) { stop(); setPlayhead(0); return; }",
      "      setPlayhead(h);",
      "      rafRef.current = requestAnimationFrame(tick);",
      "    };",
    ],
    "tick loop wrap",
  ],
  [
    [
      "  const stopFlagRef = useRef(0);",
    ],
    [
      "  const stopFlagRef = useRef(0);",
      "  // The rAF tick reads the loop region through a ref so toggling",
      "  // Loop or moving I/O mid-playback takes effect immediately.",
      "  const loopRegionRef = useRef(loopRegion);",
      "  loopRegionRef.current = loopRegion;",
    ],
    "loop region ref",
  ],
]);

patch("app/src/renderer/src/components/ProductionWorkspace.tsx", [
  [
    'import { buildTimelineOverride, timelineTotalSec, type TimelineOverride } from "./production/timeline-preview.js";',
    'import { buildTimelineOverride, EMPTY_LOOP_REGION, timelineTotalSec, type TimelineLoopRegion, type TimelineOverride } from "./production/timeline-preview.js";',
    "workspace imports",
  ],
  [
    [
      "  const [playheadSec, setPlayheadSec] = useState(0);",
      "  const [playing, setPlaying] = useState(false);",
    ],
    [
      "  const [playheadSec, setPlayheadSec] = useState(0);",
      "  const [playing, setPlaying] = useState(false);",
      "  // Loop In/Out region: marked in the editor (I/O keys + Loop",
      "  // toggle), honored by the preview transport above.",
      "  const [loopRegion, setLoopRegion] = useState<TimelineLoopRegion>(EMPTY_LOOP_REGION);",
    ],
    "section loop state",
  ],
  [
    "        onSaveAsReference={onSaveAsReference}",
    [
      "        onSaveAsReference={onSaveAsReference}",
      "        loopRegion={loopRegion}",
    ],
    "preview loop prop",
  ],
  [
    "        onSeek={seek}",
    [
      "        onSeek={seek}",
      "        loopRegion={loopRegion}",
      "        onLoopRegionChange={setLoopRegion}",
    ],
    "editor loop props",
  ],
]);

console.log("done");
