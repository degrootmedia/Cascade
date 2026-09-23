import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DetachedCanvasApp } from "./components/DetachedCanvasApp.js";
import "./styles.css";

// The detached canvas window boots the same bundle with `?window=detached`
// (Spec 03) — it renders the canvas host instead of the full chat shell.
const params = new URLSearchParams(window.location.search);
const isDetachedCanvas = params.get("window") === "detached";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isDetachedCanvas ? <DetachedCanvasApp /> : <App />}
  </React.StrictMode>
);
