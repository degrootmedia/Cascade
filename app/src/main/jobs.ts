/**
 * The main-process generation job ledger (architecture hardening workstream 3,
 * recommendation 3 of the brief).
 *
 * One authoritative lifecycle for every generation: queued → running →
 * succeeded/failed. The ledger — not the promise chain that started the job —
 * owns the state, so a missed completion event, a closed window, or a crash
 * can never leave a surface stuck on a spinner. Renderers subscribe to
 * `snapshot`s and render busy state from them; a window opened mid-generation
 * requests the current snapshot, then listens.
 *
 * Non-terminal jobs are persisted through the injected `persist` seam (main
 * wires a file under userData; tests inject memory or nothing). On startup,
 * `loadPersisted` returns jobs that were running when the app died; the ledger
 * marks them `interrupted` — a visible, recoverable terminal state that pairs
 * with the persisted `pendingImageGen`/`pendingVideoGen` recheck affordances —
 * never an indefinite spinner and never a silent drop.
 */
import type { JobKind, JobRecord, JobSnapshot, JobState } from "../shared/ipc.js";

export interface JobBeginOptions {
  productionId: string;
  kind: JobKind;
  label: string;
  shotId?: string;
  nodeId?: string;
}

/** A running job's finish controls. */
export interface JobHandle {
  id: string;
  succeed(): void;
  fail(error: string): void;
}

export interface JobLedgerDeps {
  now?: () => string;
  newId?: () => string;
  /** Persist the non-terminal jobs (main wires a file; tests skip). */
  persist?: (active: JobRecord[]) => void;
  /** Jobs persisted by a previous run (crash recovery). */
  loadPersisted?: () => JobRecord[];
}

/** How many recently finished jobs the snapshot keeps per production, so a
 *  late subscriber still sees what just completed. */
const TERMINAL_WINDOW = 12;

export interface JobLedger {
  begin(opts: JobBeginOptions): JobHandle;
  snapshot(productionId?: string): JobSnapshot;
  /** Drop a finished/interrupted job from the visible ledger. */
  dismiss(id: string): void;
  subscribe(listener: (snapshot: JobSnapshot) => void): () => void;
  /** Jobs recovered from a crash (running → interrupted). */
  readonly interrupted: JobRecord[];
}

export function createJobLedger(deps: JobLedgerDeps = {}): JobLedger {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const jobs = new Map<string, JobRecord>();
  const listeners = new Set<(snapshot: JobSnapshot) => void>();
  const interrupted: JobRecord[] = [];

  const persist = (): void => {
    if (!deps.persist) return;
    const active = [...jobs.values()].filter((j) => j.state === "running");
    deps.persist(active);
  };

  const buildSnapshot = (productionId?: string): JobSnapshot => {
    const list = [...jobs.values()]
      .filter((j) => !productionId || j.productionId === productionId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return { productionId: productionId ?? "", jobs: list };
  };

  const emit = (productionId: string): void => {
    const snap = buildSnapshot(productionId);
    for (const l of listeners) {
      try { l(snap); } catch { /* a listener must not break the ledger */ }
    }
  };

  const setState = (rec: JobRecord, state: JobState, error?: string): void => {
    rec.state = state;
    rec.finishedAt = state === "succeeded" || state === "failed" || state === "interrupted" ? now() : rec.finishedAt;
    if (error !== undefined) rec.error = error;
    if (state === "succeeded" || state === "failed") pruneTerminal(rec.productionId);
    persist();
    emit(rec.productionId);
  };

  const pruneTerminal = (productionId: string): void => {
    const finished = [...jobs.values()].filter(
      (j) => j.productionId === productionId && (j.state === "succeeded" || j.state === "failed")
    );
    if (finished.length <= TERMINAL_WINDOW) return;
    const drop = finished.slice(0, finished.length - TERMINAL_WINDOW);
    for (const j of drop) jobs.delete(j.id);
  };

  // Crash recovery: jobs that were running when the app died become a visible
  // terminal state instead of vanishing (or worse, spinning forever).
  const recovered = (deps.loadPersisted?.() ?? []).filter(
    (j) => j && typeof j.id === "string" && typeof j.productionId === "string" && j.state === "running"
  );
  for (const j of recovered) {
    const rec: JobRecord = { ...j, state: "interrupted", finishedAt: now() };
    jobs.set(rec.id, rec);
    interrupted.push(rec);
  }

  return {
    begin(opts) {
      const id = newId();
      const rec: JobRecord = {
        id,
        productionId: opts.productionId,
        ...(opts.shotId ? { shotId: opts.shotId } : {}),
        ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
        kind: opts.kind,
        state: "running",
        label: opts.label,
        startedAt: now(),
      };
      jobs.set(id, rec);
      persist();
      emit(rec.productionId);
      return {
        id,
        succeed() { setState(rec, "succeeded"); },
        fail(error: string) { setState(rec, "failed", error.slice(0, 500)); },
      };
    },
    snapshot(productionId) {
      return buildSnapshot(productionId);
    },
    dismiss(id) {
      const rec = jobs.get(id);
      if (rec && (rec.state === "succeeded" || rec.state === "failed" || rec.state === "interrupted")) {
        jobs.delete(id);
        const i = interrupted.indexOf(rec);
        if (i >= 0) interrupted.splice(i, 1);
        persist();
        emit(rec.productionId);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get interrupted() { return [...interrupted]; },
  };
}
