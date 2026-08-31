/**
 * jsdom globals for the renderer-component tests. This runs BEFORE any test
 * module (and before react-dom) loads, so React's module-load-time feature
 * detection (e.g. whether the `input` event is natively supported) sees a real
 * DOM and uses the modern event path instead of the IE9 polyfill.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
g.Node = dom.window.Node;
g.NodeFilter = dom.window.NodeFilter;
g.MouseEvent = dom.window.MouseEvent;
g.Event = dom.window.Event;
g.HTMLElement = dom.window.HTMLElement;
g.getSelection = dom.window.getSelection.bind(dom.window);
// jsdom doesn't implement the animation-frame API — a no-op stub is enough for
// React Flow's layout pass (no real timers, so no pending-timeout leaks).
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.DOMMatrixReadOnly = dom.window.DOMMatrixReadOnly;