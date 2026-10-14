import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { AgentEventIpc, AgentMeta, ApprovalRequestIpc, VerificationRequestIpc, ChatBalance, MediaProviderId, MediaProviderInfo, ModelInfo, SessionGoal, SessionMeta, SessionTasks, SettingsView, VoiceStatusIpc, WorkspaceInstructionsInfo, ActiveProductionInfo } from "../../shared/ipc.js";
import type { ChatAttachment, DisplayItem } from "./types.js";
import { useVoiceInput } from "./voice-input.js";
import { Transcript } from "./components/Transcript.js";
import { TodoPanel } from "./components/TodoPanel.js";
import { GoalPanel } from "./components/GoalPanel.js";
import { ApprovalModal } from "./components/ApprovalModal.js";
import { ConfirmHost } from "./components/ConfirmDialog.js";
import { VerifyApprovalModal } from "./components/VerifyApprovalModal.js";
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
import { clipboardText } from "./clipboard.js";
import { AttachFileIcon, XIcon } from "./components/icons.js";
import { expandCommand } from "../../shared/commands.js";

import { applyAccent } from "./theme.js";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** The production workspace is expensive and stays mounted while chats stream;
 *  memoize it (with a stable `onOpenSettings`) so a per-token chat re-render
 *  doesn't rebuild the whole workspace. */
const MemoProductionWorkspace = memo(ProductionWorkspace);

/** Whether an attachment is an image (rendered as a thumbnail, not a file chip). */
function isImage(a: ChatAttachment): boolean {
  return a.mime.startsWith("image/");
}

/** Line-art microphone for the composer's voice-input button. */
function MicIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
      <line x1="8" y1="21" x2="16" y2="21" />
    </svg>
  );
}

export function App() {
  const [transcripts, setTranscripts] = useState<Record<string, DisplayItem[]>>({});
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  /** Local voice input (Whisper): enabled flag, engine/model status, and the
   *  composer text captured when dictation started (the transcript appends). */
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatusIpc | null>(null);
  const [voiceBase, setVoiceBase] = useState("");
  const voice = useVoiceInput((transcript) => {
    const base = voiceBase.trim();
    setInput(base ? `${base} ${transcript}` : transcript);
  });
  const [approval, setApproval] = useState<ApprovalRequestIpc | null>(null);
  const [verification, setVerification] = useState<VerificationRequestIpc | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const openSettings = useCallback(() => setShowSettings(true), []);
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
  /** This chat mirrors the active Production Assistant project's folder. */
  const [followProduction, setFollowProduction] = useState(false);
  const [activeProduction, setActiveProduction] = useState<ActiveProductionInfo | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [instructions, setInstructions] = useState<WorkspaceInstructionsInfo | null>(null);
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeMeta, setActiveMeta] = useState<AgentMeta | null>(null);
  const [showAgents, setShowAgents] = useState(false);
  /** Plan mode for the current chat (research + plan first, mutations gated). */
  const [planMode, setPlanMode] = useState(false);
  /** Autonomous mode for the current chat (full permission, no approval prompts). */
  const [autonomousMode, setAutonomousMode] = useState(false);
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
  // Mount the production workspace lazily on first visit, then keep it mounted
  // (see below) so background generations survive Chat ↔ Prod switches.
  const [prodEverOpen, setProdEverOpen] = useState(() => {
    try {
      return localStorage.getItem("cascade.view") === "prod";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (view === "prod") setProdEverOpen(true);
  }, [view]);
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
  // The composer's growth cap must follow window resizes; innerHeight read inline
  // only refreshed when an unrelated render happened to occur.
  const [viewportH, setViewportH] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
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

  // While dictating, the composer shows the committed text plus the live
  // transcript; the button is shown whenever voice is enabled.
  const voiceBaseTrim = voiceBase.trim();
  const composerValue = voice.recording
    ? voiceBaseTrim + (voice.interim ? (voiceBaseTrim ? "\n" : "") + voice.interim : "")
    : input;
  const voiceTitle = voice.recording
    ? "Stop dictation"
    : voiceStatus && !voiceStatus.available
      ? "Voice input needs the speech engine — see Settings → Voice"
      : voice.preparing
        ? "Preparing the speech model…"
        : "Dictate with your voice";

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

  const refreshWorkspace = useCallback(async () => {
    try {
      const st = await window.cascade.getWorkspaceState();
      setWorkspace(st.workspace);
      setFollowProduction(st.followProduction);
      setActiveProduction(st.production);
    } catch { /* keep last-known values */ }
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
    void window.cascade.getVoiceEnabled().then(setVoiceEnabled).catch(() => {});
    void window.cascade.getVoiceStatus().then(setVoiceStatus).catch(() => {});
    try { setAgents(await window.cascade.listAgents()); } catch {}
    let sid: string | null = null;
    await Promise.all([
      refreshWorkspace(),
      window.cascade.getRecentWorkspaces().then(setRecents),
      window.cascade.getCurrentSessionId().then((id) => { sid = id; setCurrentId(id); }),
      window.cascade.getWorkspaceInstructions().then(setInstructions),
    ]);
    if (sid) {
      void refreshActiveAgent(sid);
      // Restore the durable task list for the reopened chat (restart path).
      const id: string = sid;
      void window.cascade.getPlanMode(id).then(setPlanMode);
      void window.cascade.getAutonomousMode(id).then(setAutonomousMode);
      void window.cascade.getSessionTodos(id).then((t) => setTodos((p) => ({ ...p, [id]: t }))).catch(() => {});
      void window.cascade.getSessionGoal(id).then((g) => setGoals((p) => ({ ...p, [id]: g }))).catch(() => {});
    }
    if (s.hasApiKey) void window.cascade.listModels().then((r) => { if (r.ok) setModels(r.models); }).catch(() => {});
  }, [refreshActiveAgent, refreshWorkspace]);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  // The active Production Assistant project changing (or the focused chat
  // switching) can re-point a follower chat's folder — re-read the chip.
  useEffect(() => {
    const off = window.cascade.onWorkspaceChanged(() => {
      void refreshWorkspace();
      void window.cascade.getWorkspaceInstructions().then(setInstructions);
      if (currentId) void refreshActiveAgent(currentId);
    });
    return off;
  }, [refreshWorkspace, refreshActiveAgent, currentId]);

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
    if (mediaProvider === id) return;
    setMediaProvider(id);
    // Side effects stay OUT of the state updater: React may invoke updaters more
    // than once (StrictMode, future concurrent features), which would duplicate
    // the provider write and the refresh broadcast.
    void window.cascade.setMediaProvider(id).then(() => {
      window.dispatchEvent(new Event("cascade:media-provider-changed"));
    }).catch(() => void refreshMedia());
  }, [mediaProvider, refreshMedia]);

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
    const offVerification = window.cascade.onVerificationRequest(setVerification);
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
      offVerification();
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
    if ((!raw && attachments.length === 0) || !id || busy || voice.recording) return;
    // Slash commands (e.g. /research, /plan, /plan-mode on) expand to a plain
    // instruction; /plan-mode toggles the gate and sends nothing.
    const cmd = expandCommand(raw);
    let text = raw;
    let togglePlan: boolean | undefined;
    let toggleAuto: boolean | undefined;
    if (cmd) {
      if (cmd.planMode !== undefined) togglePlan = cmd.planMode;
      if (cmd.autonomousMode !== undefined) toggleAuto = cmd.autonomousMode;
      if (cmd.instruction) text = cmd.instruction;
      else if (cmd.name === "plan-mode" || cmd.name === "autonomous") text = "";
    }
    if (!text && togglePlan === undefined && toggleAuto === undefined && attachments.length === 0) return;
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
          if (togglePlan) setAutonomousMode(false);
        } catch {
          /* ignore */
        }
      }
      if (toggleAuto !== undefined) {
        try {
          await window.cascade.setAutonomousMode(id, toggleAuto);
          setAutonomousMode(toggleAuto);
          if (toggleAuto) setPlanMode(false);
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
    void refreshWorkspace();
    void window.cascade.getWorkspaceInstructions().then(setInstructions);
    void window.cascade.getPlanMode(id).then(setPlanMode);
    void window.cascade.getAutonomousMode(id).then(setAutonomousMode);
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

  async function selectActiveProduction() {
    await window.cascade.setSessionWorkspaceProduction();
    await refreshWorkspace();
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
      {/* Both views stay mounted across tab switches (display:none when
        inactive) so in-flight production generations keep their local
        busy sets (regenIds, node busy ids, …) and their async completions
        still apply setProd/bust when they resolve. Unmounting the workspace
        on the way to Chat discarded that state: the side-panel button lost
        "Generating…" and the finished frame never reached the mounted
        production (only the on-demand lightbox, which reads from disk,
        showed it). */}
      <div className="app-home" hidden={view !== "home"} style={view !== "home" ? { display: "none" } : undefined}>
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
            followProduction={followProduction}
            production={activeProduction}
            onPick={() => void pickChatFolder()}
            onSelect={(dir) => void selectRecentFolder(dir)}
            onNone={() => void clearChatFolder()}
            onSelectProduction={() => void selectActiveProduction()}
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
        {voice.error && <div className="voice-error">⚠ {voice.error}</div>}
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
          {voiceEnabled && (
            <button
              className={`mic${voice.recording ? " on" : ""}`}
              title={voiceTitle}
              aria-label={voice.recording ? "Stop dictation" : "Start dictation"}
              disabled={busy || voice.preparing}
              onClick={() => {
                if (voice.recording) {
                  voice.stop();
                } else {
                  setVoiceBase(input);
                  void voice.start();
                }
              }}
            >
              <MicIcon size={18} />
            </button>
          )}
          <AutoTextarea
            ref={textareaRef}
            maxHeight={Math.round(viewportH * 0.4)}
            value={composerValue}
            readOnly={voice.recording}
            placeholder={
              voice.recording
                ? "Listening…"
                : busy
                  ? "Working…"
                  : pureChat
                    ? "Ask Cascade anything…"
                    : "Ask Cascade to do something in your workspace…"
            }
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              // Rebuild the paste from the clipboard's HTML flavor when present
              // so paragraph/line breaks the plain flavor drops survive. Falls
              // through untouched for text-free (file) pastes.
              const text = clipboardText(e.clipboardData);
              if (!text) return;
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart ?? input.length;
              const end = el.selectionEnd ?? start;
              setInput(input.slice(0, start) + text + input.slice(end));
              const caret = start + text.length;
              requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = caret; });
            }}
            onKeyDown={(e) => {
              if (voice.recording) return;
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
            <button className="send" onClick={() => void send()} disabled={voice.recording || (!input.trim() && attachments.length === 0)}>
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
              className={`plan-mode autonomous-mode${autonomousMode ? " on" : ""}`}
              title={
                autonomousMode
                  ? "Autonomous mode is on — Cascade acts without asking for approval. Click to turn off."
                  : "Autonomous mode: let Cascade run tools (including OpenArt) without asking for approval each time."
              }
              disabled={busy}
              onClick={() => {
                const id = currentId;
                if (!id) return;
                const next = !autonomousMode;
                setAutonomousMode(next);
                if (next) setPlanMode(false);
                void window.cascade.setAutonomousMode(id, next);
              }}
            >
              {autonomousMode ? "✓ Autonomous" : "Autonomous"}
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
      <div
        hidden={view !== "prod"}
        style={
          view !== "prod"
            ? { display: "none" }
            : { display: "flex", flex: 1, minHeight: 0, minWidth: 0, flexDirection: "column" }
        }
      >
        {prodEverOpen && <MemoProductionWorkspace onOpenSettings={openSettings} />}
      </div>
      <ConfirmHost />
      {approval && (
        <ApprovalModal
          request={approval}
          onDecision={(d) => {
            window.cascade.respondApproval(approval.id, d);
            setApproval(null);
          }}
        />
      )}
      {verification && (
        <VerifyApprovalModal
          request={verification}
          onDecision={(d) => {
            window.cascade.respondVerification(verification.id, d);
            setVerification(null);
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
    case "verification-start":
      return [...prev, { kind: "checks", commands: e.commands }];
    case "verification-result": {
      // Attach to the most recent checks block still awaiting its results.
      for (let i = prev.length - 1; i >= 0; i--) {
        const item = prev[i];
        if (item.kind === "checks" && item.results === undefined) {
          const updated = [...prev];
          updated[i] = { ...item, results: e.results };
          return updated;
        }
      }
      return [...prev, { kind: "checks", commands: e.results.map((r) => r.name), results: e.results }];
    }
    case "repair-round":
      return [...prev, { kind: "notice", text: `Checks failed — fixing (round ${e.round}/${e.max})…` }];
    case "verification-exhausted": {
      for (let i = prev.length - 1; i >= 0; i--) {
        const item = prev[i];
        if (item.kind === "checks" && item.exhausted === undefined) {
          const updated = [...prev];
          updated[i] = { ...item, exhausted: e.rounds };
          return updated;
        }
      }
      return prev;
    }
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
