---
name: cascade-architecture
description: Use whenever modifying the Cascade codebase (Electron app + agent core) — adding a feature, fixing a bug, or refactoring the production pipeline, OpenArt client, IPC, persistence, prompt grammar, or renderer. Load it to learn where code must live, which seams to inject, and what not to re-implement before writing or editing code.
---

# Cascade Architecture — deep modules, real seams

Cascade was deliberately deepened into **deep modules** — cohesive units with a
small interface that hide a lot of behavior. Before writing or editing any
code, read this file, then read `CONTEXT.md` (the domain glossary: module
names, seams, and decisions not to re-litigate). Use its vocabulary — module,
interface, depth, seam, adapter, leverage, locality — not "service" /
"component" / "API" / "boundary".

## The operating principles

- **Deep over shallow.** A module should hide real complexity behind a small
  interface. If a module's interface is nearly as complex as its implementation,
  it's shallow — fix it, don't add to it.
- **The deletion test.** For anything suspected shallow: would deleting it
  *concentrate* complexity (good — it's hiding logic) or just *move* it (bad —
  it's a pass-through)?
- **The interface is the test surface.** Logic behind a seam (a constructor-
  injected dependency) is testable by substituting a fake. Every new deep
  module ships with vitest coverage in `app/test/` (or `core/test/`).
- **One adapter = hypothetical seam, two = real.** If you're about to write the
  second implementation of something, extract the interface first.
- **Locality.** One concept lives in one module. If understanding a behavior
  means bouncing across files, the module boundary is wrong.

## Non-negotiables (where code lives)

1. **`app/src/main/index.ts` is a wiring layer.** No new domain logic goes in
   it. Add OpenArt/model/option/polling logic to `OpenArtClient`
   (`app/src/main/openart.ts`, inject `McpManager` via the constructor — that
   injection IS the test surface). Add prompt derivation to `pipeline.ts`.
2. **`pipeline.ts` never imports the OpenArt code.** It receives an
   `ImageGenFn` as an argument. Do not invert that.
3. **The prompt grammar has one home: `shared/prompt-grammar.ts`.** Never
   hand-roll the `@[name]` tag regex, `Style:`/`Brand identity:` paragraph
   parsing, loose-JSON extraction, or data-URL decoding. Import from it.
4. **Persistence goes through `store.ts` (`createStore`).** Don't write bespoke
   JSON readdir/parse/sort/archive code. Document shape rules (normalize,
   applyRendererState) live in the domain store module, not in IPC handlers.
5. **IPC channels are declared once in `ipcContract` (`shared/ipc.ts`).** A new
   channel = one contract entry; preload and main follow mechanically. Never
   add a raw `ipcMain.handle` outside the contract wrappers.
6. **Testable main-process modules soft-import Electron.** Follow `mcp.ts`:
   `let nativeImage; void import("electron").then(...)` — never a top-level
   `import { nativeImage } from "electron"` in a module tests must load.
7. **The pipeline is deliberately NOT a free-form agent loop.** One-shot bounded
   LLM calls, distinct from the `core/` agent loop. Don't "improve" that.
8. **No scratch files.** Keepers go in `app/scripts/`. No `tmp_*`, `probe-*`,
   `_*`, `*.log`, or committed dumps. `phase0/` is the intentional probe home.

## When adding behavior

- Name the deep module after the domain concept (see `CONTEXT.md`); add new
  concepts to `CONTEXT.md` as you introduce them.
- Put pure logic behind a seam so it's unit-testable; add tests at the seam
  (fake the injected dependency — see `app/test/openart.test.ts` for the fake
  `McpManager` pattern).
- Verify before done: `npm run typecheck`, `npm test`, `npm run build` (in
  `app/`), and `npm test` (in `core/`) as appropriate. Do not mark done without
  them.
- If you reject a change with a load-bearing reason, offer to record it as an
  ADR in `CONTEXT.md`'s "Decisions not to re-litigate" so future reviews don't
  re-suggest it.