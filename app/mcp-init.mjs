const base = "https://mcp.openart.ai/mcp";
(async () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "1.0" } } };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify(init),
      signal: ctrl.signal
    });
    console.log("INIT status", r.status);
    const text = await r.text();
    console.log("INIT body:", text.slice(0, 800));
    // If we got a session, try tools/list
  } catch (e) {
    console.error("ERR", String(e).slice(0, 400));
  } finally {
    clearTimeout(t);
    process.exit(0);
  }
})();