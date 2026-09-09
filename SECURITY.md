# Security model

How Cascade stays safe while running model-driven commands on your machine.

1. **No shell.** Agent `run_command` input is tokenized in-process
   (`parseArgv` in `core/src/tools.ts`) into an argv array and launched via
   `spawn(..., { shell: false })`. Pipes, redirection, substitution, chaining,
   and globbing are rejected with an error, never interpreted. `.bat`/`.cmd`/
   `.ps1` targets are refused (they would re-enter a script interpreter).
2. **Human approval is the only execution boundary.** `run_command` requires
   approval unconditionally. `labelCommandRisk` only styles the approval
   dialog (`destructive` / `network` / `normal`) — it never permits execution.
3. **No elevation.** The app never requests Administrator/root. The external
   editor launches via `spawn(editor, [file], { shell: false })` or the OS
   default (`shell.openPath`); script files cannot be configured as editors.
4. **Media is confined and streamed.** `cascade-media://` serves
   production-folder files only (`assetPath` realpath containment, symlink
   escapes rejected), streams 256 KiB chunks with Range/`206` support (no full
   file buffering), does not bypass CSP, and sends no wildcard CORS headers.
5. **MCP servers get a minimal environment.** Children receive a fixed
   allowlist of platform variables plus operator-declared `env` and opt-in
   `envPassthrough` names — never the full parent environment or provider keys.
6. **Conversations stay out of logs.** Only message metadata is logged unless
   `CASCADE_DEBUG_CHAT=1` is set, and debug payloads are secret-redacted.
7. **IPC is validated in main.** Every `invoke`/`send` handler checks the
   sender frame origin and schema-validates its payload (`validateIpcArgs`);
   messages from embedded frames are rejected.
8. **Hardened packaging.** One electron-builder config
   (`app/electron-builder.json`), Electron fuses flipped in `afterPack`
   (no `RunAsNode`, no inspect CLI, asar integrity + app-only loading, cookie
   encryption), hardened runtime + notarization on macOS, Authenticode
   timestamping on Windows.

## Reporting

Report suspected vulnerabilities as a private issue to the Cascade
maintainers. Do not file public issues with exploit details or debug logs.
