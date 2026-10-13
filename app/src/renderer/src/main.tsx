import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DetachedCanvasApp } from "./components/DetachedCanvasApp.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import "./styles.css";

// The detached canvas window boots the same bundle with `?window=detached`
// (Spec 03) — it renders the canvas host instead of the full chat shell.
const params = new URLSearchParams(window.location.search);
const isDetachedCanvas = params.get("window") === "detached";

// Route uncaught renderer errors to the main-process log (captured via
// console-message) so a crash that never reaches React is still diagnosable.
window.addEventListener("error", (e) => {
  console.error("[renderer] uncaught error:", e.error?.stack ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = (e as PromiseRejectionEvent).reason;
  console.error("[renderer] unhandled rejection:", r instanceof Error ? r.stack : String(r));
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>{isDetachedCanvas ? <DetachedCanvasApp /> : <App />}</ErrorBoundary>
  </React.StrictMode>
);
