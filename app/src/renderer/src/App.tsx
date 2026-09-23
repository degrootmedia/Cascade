import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEventIpc, AgentMeta, ApprovalRequestIpc, ChatBalance, MediaProviderId, MediaProviderInfo, ModelInfo, SessionGoal, SessionMeta, SessionTasks, SettingsView, WorkspaceInstructionsInfo } from "../../shared/ipc.js";
import type { ChatAttachment, DisplayItem } from "./types.js";
import { Transcript } from "./components/Transcript.js";
import { TodoPanel } from "./components/TodoPanel.js";
import { GoalPanel } from "./components/GoalPanel.js";
import { ApprovalModal } from "./components/ApprovalModal.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { OPEN_SETTINGS_EVENT } from "./components/settings/open-settings.js";
import { ModelCustomizer } from "./components/ModelCustomizer.js";
import { Sidebar } from "./components/Sidebar.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { MediaProviderToggle, type MediaCredits } from "./components/MediaProviderToggle.js";
import { TRANSPORT_CHANGED, firstVisibleAvailable, hasStoredTransportMode, isProviderVisible, readTransportMode, writeTransportMode, type ProviderTransportMode } from "./components/media-transport.js";
import { FolderPicker } from "./components/FolderPicker.js";
import { AgentPicker } from "./components/AgentPicker.js";
import { AgentsPanel } from "./components/AgentsPanel.js";
import { ViewTabs, type AppView } from "./components/ViewTabs.js";
import { ProductionWorkspace } from "./components/ProductionWorkspace.js";
import { AutoTextarea } from "./components/AutoTextarea.js";
import { AttachFileIcon, StopButtonIcon, XIcon } from "./components/icons.js";
import { expandCommand } from "../../shared/commands.js";

import { applyAccent } from "./theme.js";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Whether an attachment is an image (rendered as a thumbnail, not a file chip). */
function isImage(a: ChatAttachment): boolean {
  return a.mime.startsWith("image/");
}

export function App() {
  const [transcripts, setTranscripts] = useState<Record<string, DisplayItem[]>>({});
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [approval, setApproval] = useState<ApprovalRequestIpc | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showModelCustomizer, setShowModelCustomizer] = useState(false);
  const [sessionList, setSessionList] = useState<SessionMeta[]>([]);
  const [credits, setCredits] = useState<ChatBalance | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  /** Top-bar media dial: active vendor, per-vendor balances + availability. */
  const [mediaProvider, setMediaProvider] = useState<MediaProviderId>("openart");
  const [mediaCredits, setMediaCredits] = useState<MediaCredits>({ openart: null, "higgsfield-cli": null, "openart-cli": null });
  const [mediaAvailable, setMediaAvailable] = useState<Record<MediaProviderId, boolean>>({ openart: true, "higgsfield-cli": true, "openart-cli": true });
  const [mediaProviderList, setMediaProviderList] = useState<MediaProviderInfo[]>([]);
  /** Transport toggle (MCP vs CLI): which provider family the top bar and
   *  Settings show. Persisted; defaults to MCP. */
  const [transportMode, setTransportMode] = useState<ProviderTransportMode>(() => readTransportMode());
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [instructions, setInstructions] = useState<WorkspaceInstructionsInfo | null>(null);
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeMeta, setActiveMeta] = useState<AgentMeta | null>(null);
  const [showAgents, setShowAgents] = useState(false);
  /** Plan mode for the current chat (research + plan first, mutations gated). */
  const [planMode, setPlanMode] = useState(false);
  /** Durable per-chat task lists, keyed by session (file is the truth in main). */
  const [todos, setTodos] = useState<Record<string, SessionTasks>>({});
  /** Durable per-chat goals, keyed by session (the objective; todos are steps). */
  const [goals, setGoals] = useState<Record<string, SessionGoal>>({});
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

  const currentModel = settings?.model ?? "";
  const effectiveModel = activeMeta?.model ?? currentModel;
  const modelInfo = models.find((m) => m.id === effectiveModel);
  /** Pure chat = no folder selected for this chat. */
  const pureChat = !workspace;

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
    if (sid) {
      void refreshActiveAgent(sid);
      // Restore the durable task list for the reopened chat (restart path).
      const id: string = sid;
      void window.cascade.getSessionTodos(id).then((t) => setTodos((p) => ({ ...p, [id]: t }))).catch(() => {});
      void window.cascade.getSessionGoal(id).then((g) => setGoals((p) => ({ ...p, [id]: g }))).catch(() => {});
    }
    if (s.hasApiKey) void window.cascade.listModels().then((r) => { if (r.ok) setModels(r.models); }).catch(() => {});
  }, [refreshActiveAgent]);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  /** Top-bar dial data: active vendor + per-vendor balances + availability. */
  const refreshMedia = useCallback(async () => {
    try {
      const [id, credits, list] = await Promise.all([
        window.cascade.getMediaProvider(),
        window.cascade.getMediaCredits(),
        window.cascade.listMediaProviders(),
      ]);
      setMediaProvider(id);
      setMediaCredits(credits);
      setMediaProviderList(list);
      // First-run migration: existing CLI users (active provider on the CLI
      // transport, no stored mode) start in CLI mode instead of being
      // silently switched to MCP.
      if (!hasStoredTransportMode() && id.endsWith("-cli")) {
        writeTransportMode("cli");
        setTransportMode("cli");
      }
      setMediaAvailable((prev) => {
        const next = { ...prev };
        for (const p of list) next[p.id] = p.available;
        return next;
      });
    } catch {
      /* keep last-known values */
    }
  }, []);

  useEffect(() => {
    void refreshMedia();
    const onChange = () => void refreshMedia();
    window.addEventListener("cascade:media-provider-changed", onChange);
    window.addEventListener("focus", onChange);
    // Perf 1.6: the 60s poll never fires while the tab is hidden — visibility
    // resume triggers an immediate refresh instead. Long node-editor sessions
    // stop paying a periodic main-thread stall in the background.
    let timer: number | undefined;
    const startPoll = () => {
      if (timer !== undefined) return;
      timer = window.setInterval(() => {
        if (document.hidden) return;
        void refreshMedia();
      }, 60_000);
    };
    const stopPoll = () => {
      if (timer !== undefined) { window.clearInterval(timer); timer = undefined; }
    };
    const onVisibility = () => {
      if (document.hidden) { stopPoll(); return; }
      startPoll();
      void refreshMedia();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) startPoll();
    return () => {
      window.removeEventListener("cascade:media-provider-changed", onChange);
      window.removeEventListener("focus", onChange);
      document.removeEventListener("visibilitychange", onVisibility);
      stopPoll();
    };
  }, [refreshMedia]);

  /** Dial selection: optimistic flip, then broadcast so production views refresh. */
  const selectMedia = useCallback((id: MediaProviderId) => {
    setMediaProvider((prev) => {
      if (prev === id) return prev;
      void window.cascade.setMediaProvider(id).then(() => {
        window.dispatchEvent(new Event("cascade:media-provider-changed"));
      }).catch(() => void refreshMedia());
      return id;
    });
  }, [refreshMedia]);

  /** Transport flip: persist the mode first, then reconcile the active
   *  provider so it never points at the hidden transport. When nothing is
   *  visible+available under the new mode, the active provider is left
   *  untouched (and no change event fires) — the toggle tooltip says so. */
  const selectTransport = useCallback((mode: ProviderTransportMode) => {
    writeTransportMode(mode);
    setTransportMode(mode);
    if (!mediaProviderList.some((p) => p.id === mediaProvider && isProviderVisible(p.id, mode))) {
      const target = firstVisibleAvailable(mediaProviderList, mode);
      if (target) selectMedia(target);
    }
  }, [mediaProvider, mediaProviderList, selectMedia]);

  // A transport flip in Settings applies here too (same persisted mode).
  useEffect(() => {
    const onTransport = () => setTransportMode(readTransportMode());
    window.addEventListener(TRANSPORT_CHANGED, onTransport);
    return () => window.removeEventListener(TRANSPORT_CHANGED, onTransport);
  }, []);

  // First-run: open settings if there's no API key yet (workspace is optional — pure chat works without one).
  useEffect(() => {
    if (settings && !settings.hasApiKey) setShowSettings(true);
  }, [settings]);

  // File → Settings… from the native menu opens the settings panel.
  useEffect(() => window.cascade.onOpenSettings(() => setShowSettings(true)), []);

  // Renderer features can open Settings on a specific section via
  // `openSettings("providers")` (Spec 05) — the panel consumes the section.
  useEffect(() => {
    const onOpen = () => setShowSettings(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, []);

  useEffect(() => {
    const offSwitched = window.cascade.onAgentSwitched(({ sessionId, frame }) => {
      updateTranscript(sessionId, (prev) => [...prev, frame]);
      window.cascade.syncDisplay(sessionId, transcriptsRef.current[sessionId] ?? []);
      if (sessionId === currentId) void refreshActiveAgent(sessionId);
    });
    const offEvent = window.cascade.onAgentEvent(({ sessionId, event }) => {
      const nextItems = updateTranscript(sessionId, (prev) => applyEvent(prev, event));
      if (event.type === "agent-done") {
        setBusyIds((p) => ({ ...p, [sessionId]: false }));
        // Persist the completed transcript to this chat's session file, even
        // if it finished in the background.
        window.cascade.syncDisplay(sessionId, nextItems);
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
    const offTodos = window.cascade.onTodosChanged(({ sessionId, tasks }) => {
      setTodos((p) => ({ ...p, [sessionId]: tasks }));
    });
    const offGoal = window.cascade.onGoalChanged(({ sessionId, goal }) => {
      setGoals((p) => ({ ...p, [sessionId]: goal }));
    });
    return () => {
      offSwitched();
      offEvent();
      offApproval();
      offRenamed();
      offMention();
      offTodos();
      offGoal();
    };
  }, [currentId, refreshActiveAgent]);

  async function attachFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
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
      setAttachments((prev) => [...prev, { dataUrl, name: file.name, mime: file.type }]);
    }
  }

  async function send() {
    const raw = input.trim();
    const id = currentId;
    if ((!raw && attachments.length === 0) || !id || busy) return;
    // Slash commands (e.g. /research, /plan, /plan-mode on) expand to a plain
    // instruction; /plan-mode toggles the gate and sends nothing.
    const cmd = expandCommand(raw);
    let text = raw;
    let togglePlan: boolean | undefined;
    if (cmd) {
      if (cmd.planMode !== undefined) togglePlan = cmd.planMode;
      if (cmd.instruction) text = cmd.instruction;
      else if (cmd.name === "plan-mode") text = "";
    }
    if (!text && !togglePlan && attachments.length === 0) return;
    const sendAttachments = attachments;
    setInput("");
    setAttachments([]);
    setBusyIds((p) => ({ ...p, [id]: true }));
    // Make the chat visible in the sidebar the moment the question is asked,
    // before the response starts arriving.
    void window.cascade.listSessions().then(setSessionList);
    try {
      // /plan-mode toggles the gate (and sends nothing); /plan also flips it on
      // before sending the plan instruction.
      if (togglePlan !== undefined) {
        try {
          await window.cascade.setPlanMode(id, togglePlan);
          setPlanMode(togglePlan);
        } catch {
          /* ignore */
        }
      }
      if (text) {
        updateTranscript(id, (prev) => [...prev, { kind: "user", text, attachments: sendAttachments.length ? sendAttachments : undefined }]);
        try {
          await window.cascade.sendMessage(id, text, sendAttachments.length ? sendAttachments : undefined);
        } catch (err) {
          const msg = String(err);
          const friendly = msg.includes("NO_API_KEY")
            ? "Add your API key in Settings first."
            : msg;
          updateTranscript(id, (prev) => [...prev, { kind: "notice", text: friendly }]);
          if (msg.includes("NO_API_KEY")) setShowSettings(true);
        }
      }
      void window.cascade.listSessions().then(setSessionList);
    } finally {
      setBusyIds((p) => ({ ...p, [id]: false }));
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
      const display = await window.cascade.loadSession(id);
      setTranscript(id, clearStreaming(display));
    }
    void window.cascade.getCurrentWorkspace().then(setWorkspace);
    void window.cascade.getWorkspaceInstructions().then(setInstructions);
    void window.cascade.getPlanMode(id).then(setPlanMode);
    void window.cascade.getSessionTodos(id).then((t) => setTodos((p) => ({ ...p, [id]: t }))).catch(() => {});
    void window.cascade.getSessionGoal(id).then((g) => setGoals((p) => ({ ...p, [id]: g }))).catch(() => {});
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
      void refreshActiveAgent(currentId);
    }
  }

  async function selectRecentFolder(dir: string) {
    await window.cascade.setSessionWorkspace(dir);
    setWorkspace(dir);
    void window.cascade.getRecentWorkspaces().then(setRecents);
    void window.cascade.getWorkspaceInstructions().then(setInstructions);
    void refreshActiveAgent(currentId);
  }

  async function clearChatFolder() {
    await window.cascade.setSessionWorkspaceNone();
    setWorkspace(null);
    void window.cascade.getWorkspaceInstructions().then(setInstructions);
    void refreshActiveAgent(currentId);
  }

  return (
    <div className="app">
      <ViewTabs
        value={view}
        onChange={switchView}
        rightContent={
          <>
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
            <span className="view-tabs-divider" aria-hidden="true" />
            {(() => {
              const visibleProviders = mediaProviderList.filter((p) => isProviderVisible(p.id, transportMode));
              const noneAvailable = visibleProviders.length > 0 && visibleProviders.every((p) => !p.available);
              return (
                <>
                  <div
                    className="media-toggle"
                    role="radiogroup"
                    aria-label="Media transport"
                    title={noneAvailable
                      ? `No ${transportMode === "cli" ? "CLI" : "MCP"} provider is available — switch transport or connect one in Settings → Media generation`
                      : "MCP servers or local CLI binaries drive image/video generation"}
                  >
                    {(["mcp", "cli"] as const).map((m) => (
                      <button
                        key={m}
                        role="radio"
                        aria-checked={transportMode === m}
                        aria-label={m === "mcp" ? "MCP transport" : "CLI transport"}
                        title={m === "mcp" ? "Generate via MCP servers" : "Generate via local CLI binaries"}
                        className={"media-half" + (transportMode === m ? " active" : "")}
                        onClick={() => { if (m !== transportMode) selectTransport(m); }}
                      >
                        {m === "mcp" ? "MCP" : "CLI"}
                      </button>
                    ))}
                  </div>
                  <MediaProviderToggle
                    active={mediaProvider}
                    credits={mediaCredits}
                    available={mediaAvailable}
                    providers={visibleProviders}
                    onSelect={selectMedia}
                  />
                </>
              );
            })()}
          </>
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
          {!pureChat && (
            <AgentPicker agents={agents} activeAgentId={activeAgentId} activeMeta={activeMeta} onChange={(id) => { if (!currentId) return; void window.cascade.setSessionAgent(currentId, id); }} onManage={() => setShowAgents(true)} />
          )}
          <FolderPicker
            current={workspace}
            recents={recents}
            instructions={instructions}
            pureChat={pureChat}
            onPick={() => void pickChatFolder()}
            onSelect={(dir) => void selectRecentFolder(dir)}
            onNone={() => void clearChatFolder()}
            onOpenInstructions={() => {
              void window.cascade.openWorkspaceInstructions();
              void window.cascade.getWorkspaceInstructions().then(setInstructions);
            }}
          />
        </div>
        <Transcript items={items} pureChat={pureChat} />
        {currentId && goals[currentId]?.goal ? (
          <GoalPanel
            goal={goals[currentId]}
            onPatch={(patch) => {
              const id = currentId;
              if (!id) return;
              void window.cascade.setSessionGoal(id, patch).then((g) => setGoals((p) => ({ ...p, [id]: g })));
            }}
          />
        ) : null}
        {currentId && todos[currentId]?.items.length ? (
          <TodoPanel tasks={todos[currentId]} />
        ) : null}
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((a, i) => (
              <div key={i} className={`attachment${isImage(a) ? "" : " file"}`}>
                {isImage(a) ? <img src={a.dataUrl} alt={a.name} /> : <span className="attach-file">{a.name}</span>}
                <button onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}><XIcon size={11} /></button>
              </div>
            ))}
            {attachments.some(isImage) && modelInfo && !modelInfo.vision && (
              <span className="attach-warning">⚠ {effectiveModel} can't see images — pick a model with image input</span>
            )}
          </div>
        )}
        <div className="composer">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf,text/*,.md,.csv,.json,.xml,.yaml,.yml,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.rtf,.epub,.odt,.ods,.odp,.tex"
            multiple
            hidden
            onChange={(e) => {
              void attachFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="attach"
            title="Attach image, PDF, or document"
            aria-label="Attach image, PDF, or document"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <AttachFileIcon size={18} className="attach-glyph" />
          </button>
          <AutoTextarea
            ref={textareaRef}
            maxHeight={Math.round(window.innerHeight * 0.4)}
            value={input}
            placeholder={busy ? "Working…" : pureChat ? "Ask Cascade anything…" : "Ask Cascade to do something in your workspace…"}
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
              <StopButtonIcon size={15} />
              Stop
            </button>
          ) : (
            <button className="send" onClick={() => void send()} disabled={!input.trim() && attachments.length === 0}>
              Send
            </button>
          )}
        </div>
        <div className="composer-footer">
          {!pureChat && (
            <button
              className={`plan-mode${planMode ? " on" : ""}`}
              title={planMode ? "Plan mode is on — file edits and commands are gated until you approve the plan. Click to turn off." : "Turn on plan mode: Cascade researches and writes a plan before it can change files."}
              disabled={busy}
              onClick={() => {
                const id = currentId;
                if (!id) return;
                const next = !planMode;
                setPlanMode(next);
                void window.cascade.setPlanMode(id, next);
              }}
            >
              {planMode ? "✓ Plan mode" : "Plan mode"}
            </button>
          )}
          {!pureChat && (
            <button
              className="undo"
              title="Restore files changed by the last response"
              disabled={busy}
              onClick={() => void undoLast()}
            >
              ↩ Undo
            </button>
          )}
        </div>
          </main>
        </div>
      ) : (
        <ProductionWorkspace onOpenSettings={() => setShowSettings(true)} />
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
          onOpenModelCustomizer={() => { setShowSettings(false); setShowModelCustomizer(true); }}
        />
      )}
      {showModelCustomizer && <ModelCustomizer onClose={() => setShowModelCustomizer(false)} />}
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
    case "notice":
      return [...prev, { kind: "notice", text: e.text }];
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
