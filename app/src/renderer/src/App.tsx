import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEventIpc, AgentMeta, ApprovalRequestIpc, ModelInfo, SessionMeta, SettingsView, WorkspaceInstructionsInfo } from "../../shared/ipc.js";
import type { DisplayItem } from "./types.js";
import { Transcript } from "./components/Transcript.js";
import { ApprovalModal } from "./components/ApprovalModal.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { FolderPicker } from "./components/FolderPicker.js";
import { AgentPicker } from "./components/AgentPicker.js";
import { AgentsPanel } from "./components/AgentsPanel.js";
import { ViewTabs, type AppView } from "./components/ViewTabs.js";
import { ProductionWorkspace } from "./components/ProductionWorkspace.js";
import { AutoTextarea } from "./components/AutoTextarea.js";

import { applyAccent } from "./theme.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function App() {
  const [transcripts, setTranscripts] = useState<Record<string, DisplayItem[]>>({});
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [approval, setApproval] = useState<ApprovalRequestIpc | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionList, setSessionList] = useState<SessionMeta[]>([]);
  const [credits, setCredits] = useState<number | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [instructions, setInstructions] = useState<WorkspaceInstructionsInfo | null>(null);
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeMeta, setActiveMeta] = useState<AgentMeta | null>(null);
  const [showAgents, setShowAgents] = useState(false);
  /** Top-level view: chat home vs. Production Assistant (persisted). */
  const [view, setView] = useState<AppView>(() => {
    try {
      return localStorage.getItem("cascade.view") === "prod" ? "prod" : "home";
    } catch {
      return "home";
    }
  });
  const switchView = useCallback((v: AppView) => {
    setView(v);
    try { localStorage.setItem("cascade.view", v); } catch { /* ignore */ }
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem("cascade.sidebarWidth"));
      return saved >= 160 && saved <= 480 ? saved : 230;
    } catch {
      return 230;
    }
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  /** Drag-to-resize the chat history (sidebar) panel. */
  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(Math.max(ev.clientX - startX + startW, 160), 480);
      setSidebarWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem("cascade.sidebarWidth", String(sidebarWidthRef.current));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // One transcript per chat (so background chats keep streaming even when not
  // focused). transcriptsRef mirrors this synchronously for mutation + read.
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;

  /** Set a chat's transcript, keeping the shared ref in sync immediately. */
  function setTranscript(sessionId: string, items: DisplayItem[]) {
    const next = { ...transcriptsRef.current, [sessionId]: items };
    transcriptsRef.current = next;
    setTranscripts(next);
  }
  /** Mutate one chat's transcript and return the new items (ref stays correct now). */
  function updateTranscript(sessionId: string, updater: (items: DisplayItem[]) => DisplayItem[]): DisplayItem[] {
    const nextItems = updater(transcriptsRef.current[sessionId] ?? []);
    setTranscript(sessionId, nextItems);
    return nextItems;
  }

  const items = currentId ? (transcripts[currentId] ?? []) : [];
  const busy = currentId ? !!busyIds[currentId] : false;

  const currentModel = settings?.model ?? "arya";
  const effectiveModel = activeMeta?.model ?? currentModel;
  const modelInfo = models.find((m) => m.id === effectiveModel);

  const refreshAgents = useCallback(async () => {
    try { setAgents(await window.cascade.listAgents()); } catch {}
  }, []);
  const refreshActiveAgent = useCallback(async (sid: string | null) => {
    if (!sid) { setActiveAgentId(null); setActiveMeta(null); return; }
    try {
      const aid = await window.cascade.getSessionAgent(sid);
      setActiveAgentId(aid);
      if (aid) {
        const d = await window.cascade.getAgent(aid);
        setActiveMeta(d?.meta ?? null);
      } else setActiveMeta(null);
    } catch { setActiveAgentId(null); setActiveMeta(null); }
  }, []);

  const refreshMeta = useCallback(async () => {
    const [s, list, c] = await Promise.all([
      window.cascade.getSettings(),
      window.cascade.listSessions(),
      window.cascade.getCredits(),
    ]);
    setSettings(s);
    applyAccent(s.accent);
    setSessionList(list);
    setCredits(c);
    try { setAgents(await window.cascade.listAgents()); } catch {}
    let sid: string | null = null;
    await Promise.all([
      window.cascade.getCurrentWorkspace().then(setWorkspace),
      window.cascade.getRecentWorkspaces().then(setRecents),
      window.cascade.getCurrentSessionId().then((id) => { sid = id; setCurrentId(id); }),
      window.cascade.getWorkspaceInstructions().then(setInstructions),
    ]);
    if (sid) void refreshActiveAgent(sid);
    if (s.hasApiKey) void window.cascade.listModels().then(setModels).catch(() => {});
  }, [refreshActiveAgent]);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  // First-run: open settings if no key or workspace yet.
  useEffect(() => {
    if (settings && (!settings.hasApiKey || !settings.workspace)) setShowSettings(true);
  }, [settings]);

  useEffect(() => {
    const offSwitched = window.cascade.onAgentSwitched(({ sessionId, frame }: { sessionId: string; frame: unknown }) => {
      updateTranscript(sessionId, (prev) => [...prev, frame as DisplayItem]);
      window.cascadeSync.syncDisplay(sessionId, transcriptsRef.current[sessionId] ?? []);
      if (sessionId === currentId) void refreshActiveAgent(sessionId);
    });
    const offEvent = window.cascade.onAgentEvent(({ sessionId, event }) => {
      const nextItems = updateTranscript(sessionId, (prev) => applyEvent(prev, event));
      if (event.type === "agent-done") {
        setBusyIds((p) => ({ ...p, [sessionId]: false }));
        // Persist the completed transcript to this chat's session file, even
        // if it finished in the background.
        window.cascadeSync.syncDisplay(sessionId, nextItems);
        void window.cascade.listSessions().then(setSessionList);
        void window.cascade.getCredits().then(setCredits);
      }
      if (event.type === "error") setBusyIds((p) => ({ ...p, [sessionId]: false }));
    });
    const offApproval = window.cascade.onApprovalRequest(setApproval);
    const offRenamed = window.cascade.onSessionRenamed(() => void window.cascade.listSessions().then(setSessionList));
    const offMention = window.cascade.onMentionAdded(({ sessionId, dataUrl, filename }) => {
      updateTranscript(sessionId, (prev) => [...prev, { kind: "mention", filename, image: dataUrl }]);
    });
    return () => {
      offSwitched();
      offEvent();
      offApproval();
      offRenamed();
      offMention();
    };
  }, [currentId, refreshActiveAgent]);

  async function attachImages(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        if (currentId)
          updateTranscript(currentId, (prev) => [...prev, { kind: "notice", text: `${file.name} is over 8 MB — skipped.` }]);
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      setImages((prev) => [...prev, dataUrl]);
    }
  }

  async function send() {
    const text = input.trim();
    const id = currentId;
    if ((!text && images.length === 0) || !id || busy) return;
    const sendImages = images;
    setInput("");
    setImages([]);
    setBusyIds((p) => ({ ...p, [id]: true }));
    // Make the chat visible in the sidebar the moment the question is asked,
    // before the response starts arriving.
    void window.cascade.listSessions().then(setSessionList);
    updateTranscript(id, (prev) => [...prev, { kind: "user", text, images: sendImages.length ? sendImages : undefined }]);
    try {
      await window.cascade.sendMessage(id, text, sendImages.length ? sendImages : undefined);
      void window.cascade.listSessions().then(setSessionList);
    } catch (err) {
      const msg = String(err);
      const friendly = msg.includes("NO_API_KEY")
        ? "Add your Gab.ai API key in Settings first."
        : msg.includes("NO_WORKSPACE")
          ? "Pick a workspace folder in Settings first."
          : msg;
      updateTranscript(id, (prev) => [...prev, { kind: "notice", text: friendly }]);
      setBusyIds((p) => ({ ...p, [id]: false }));
      if (msg.includes("NO_API_KEY") || msg.includes("NO_WORKSPACE")) setShowSettings(true);
    }
  }

  async function undoLast() {
    const id = currentId;
    if (!id || busy) return;
    try {
      const res = await window.cascade.undoLast(id);
      if (res.restored > 0) {
        const shown = res.files.slice(0, 4).join(", ") + (res.files.length > 4 ? ` … (${res.files.length} total)` : "");
        updateTranscript(id, (prev) => [
          ...prev,
          { kind: "notice", text: `↩ Undid the last response — restored ${res.restored} file(s): ${shown}` },
        ]);
      } else {
        updateTranscript(id, (prev) => [
          ...prev,
          { kind: "notice", text: "Nothing to undo — the last response made no file changes." },
        ]);
      }
      void window.cascade.listSessions().then(setSessionList);
    } catch {
      updateTranscript(id, (prev) => [...prev, { kind: "notice", text: "Couldn't undo the last response." }]);
    }
  }

  async function selectSession(id: string) {
    setCurrentId(id);
    window.cascade.activateSession(id);
    if (!transcriptsRef.current[id]) {
      const display = (await window.cascade.loadSession(id)) as DisplayItem[];
      setTranscript(id, clearStreaming(display));
    }
    void window.cascade.getCurrentWorkspace().then(setWorkspace);
    void window.cascade.getWorkspaceInstructions().then(setInstructions);
    void refreshActiveAgent(id);
  }

  async function startNewSession() {
    const id = await window.cascade.newSession();
    setCurrentId(id);
    setTranscript(id, []);
    setBusyIds((p) => ({ ...p, [id]: false }));
    void refreshMeta();
    void refreshActiveAgent(id);
  }

  async function removeSession(id: string, mode: "delete" | "archive") {
    try {
      await window.cascade.removeSession(id, mode);
    } catch {
      return;
    }
    // If the removed chat was the one open, switch to a fresh one (main resets
    // the live session on removal) so the transcript doesn't point at it.
    if (id === currentId) await startNewSession();
    else void refreshMeta();
  }

  async function pickChatFolder() {
    const dir = await window.cascade.pickSessionWorkspace();
    if (dir) {
      setWorkspace(dir);
      void window.cascade.getRecentWorkspaces().then(setRecents);
      void window.cascade.getWorkspaceInstructions().then(setInstructions);
    }
  }

  async function selectRecentFolder(dir: string) {
    await window.cascade.setSessionWorkspace(dir);
    setWorkspace(dir);
    void window.cascade.getRecentWorkspaces().then(setRecents);
    void window.cascade.getWorkspaceInstructions().then(setInstructions);
  }

  return (
    <div className="app">
      <ViewTabs
        value={view}
        onChange={switchView}
        rightContent={
          <ModelPicker
            models={models}
            current={effectiveModel}
            disabled={busy}
            onChange={(id) => {
              if (activeMeta) {
                void window.cascade.updateAgent(activeMeta.id, { model: id }).then(() => {
                  void refreshActiveAgent(currentId);
                  void refreshAgents();
                });
              } else {
                void window.cascade.setModel(id).then(() => refreshMeta());
              }
            }}
          />
        }
      />
      {view === "home" ? (
        <div className="app-home">
          <Sidebar
            sessions={sessionList}
            onSelect={selectSession}
            onNew={startNewSession}
            onSettings={() => setShowSettings(true)}
            onRemove={(id, mode) => void removeSession(id, mode)}
            onRename={(id) => void window.cascade.renameSession(id)}
            credits={credits}
            width={sidebarWidth}
          />
          <div className="sidebar-resizer" onMouseDown={startSidebarResize} title="Drag to resize chat history panel" />
          <main className="chat">
        <div className="chat-header">
          <AgentPicker agents={agents} activeAgentId={activeAgentId} activeMeta={activeMeta} onChange={(id) => { if (!currentId) return; void window.cascade.setSessionAgent(currentId, id); }} onManage={() => setShowAgents(true)} />
          <FolderPicker
            current={workspace}
            recents={recents}
            instructions={instructions}
            onPick={() => void pickChatFolder()}
            onSelect={(dir) => void selectRecentFolder(dir)}
            onOpenInstructions={() => {
              void window.cascade.openWorkspaceInstructions();
              void window.cascade.getWorkspaceInstructions().then(setInstructions);
            }}
          />
        </div>
        <Transcript items={items} />
        {images.length > 0 && (
          <div className="attachments">
            {images.map((src, i) => (
              <div key={i} className="attachment">
                <img src={src} alt={`attachment ${i + 1}`} />
                <button onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            {modelInfo && !modelInfo.vision && (
              <span className="attach-warning">⚠ {effectiveModel} can't see images — pick a model with image input</span>
            )}
          </div>
        )}
        <div className="composer">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void attachImages(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="attach"
            title="Attach image"
            aria-label="Attach image"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M16.5 8.5a3 3 0 0 0-4.24-0.15l-6 6a4.5 4.5 0 0 0 6.36 6.36l7.5-7.5a3 3 0 0 0-4.24-4.24L10 18.79a1.5 1.5 0 0 1-2.12-2.12l7.07-7.07" />
            </svg>
          </button>
          <AutoTextarea
            ref={textareaRef}
            maxHeight={Math.round(window.innerHeight * 0.4)}
            value={input}
            placeholder={busy ? "Working…" : "Ask Cascade to do something in your workspace…"}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {busy ? (
            <button
              className="stop"
              onClick={() => {
                if (currentId) window.cascade.stop(currentId);
                // Stop is fire-and-forget; clear the spinner immediately so a
                // new prompt can be typed even before the request tears down.
                setBusyIds((p) => ({ ...p, [currentId as string]: false }));
              }}
            >
              Stop
            </button>
          ) : (
            <button className="send" onClick={() => void send()} disabled={!input.trim() && images.length === 0}>
              Send
            </button>
          )}
        </div>
        <div className="composer-footer">
          <button
            className="undo"
            title="Restore files changed by the last response"
            disabled={busy}
            onClick={() => void undoLast()}
          >
            ↩ Undo
          </button>
        </div>
          </main>
        </div>
      ) : (
        <ProductionWorkspace />
      )}
      {approval && (
        <ApprovalModal
          request={approval}
          onDecision={(d) => {
            window.cascade.respondApproval(approval.id, d);
            setApproval(null);
          }}
        />
      )}
      {showSettings && settings && (
        <SettingsPanel
          settings={settings}
          onClose={() => {
            setShowSettings(false);
            void refreshMeta();
          }}
          onOpenAgents={() => { setShowSettings(false); setShowAgents(true); }}
        />
      )}
      {showAgents && <AgentsPanel onClose={() => { setShowAgents(false); void refreshAgents(); void refreshActiveAgent(currentId); }} models={models} />}
    </div>
  );
}

/** Fold an agent event into the display list. */
function applyEvent(prev: DisplayItem[], e: AgentEventIpc): DisplayItem[] {
  switch (e.type) {
    case "text-delta": {
      const last = prev[prev.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        return [...prev.slice(0, -1), { ...last, text: last.text + e.text }];
      }
      return [...prev, { kind: "assistant", text: e.text, streaming: true }];
    }
    case "text-done": {
      const last = prev[prev.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        return [...prev.slice(0, -1), { kind: "assistant", text: last.text }];
      }
      return prev;
    }
    case "tool-start":
      return [...prev, { kind: "tool", name: e.call.name, args: JSON.stringify(e.call.args, null, 2) }];
    case "tool-result": {
      // Attach to the most recent unresolved matching tool card.
      for (let i = prev.length - 1; i >= 0; i--) {
        const item = prev[i];
        if (item.kind === "tool" && item.name === e.name && item.result === undefined) {
          const updated = [...prev];
          updated[i] = { ...item, result: e.result, isError: e.isError, images: e.images };
          return updated;
        }
      }
      return prev;
    }
    case "error":
      return [...clearStreaming(prev), { kind: "notice", text: e.message }];
    case "agent-done":
      return clearStreaming(prev);
    default:
      return prev;
  }
}

/** No message should keep a blinking cursor once the turn is over. */
function clearStreaming(items: DisplayItem[]): DisplayItem[] {
  return items.map((it) => (it.kind === "assistant" && it.streaming ? { kind: "assistant", text: it.text } : it));
}
