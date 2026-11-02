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
import { AsyncLocalStorage } from "node:async_hooks";
import { createJobScheduler, type JobScheduler } from "./job-scheduler.js";

/** The ledger job the current async call chain is running under, so a
 *  provider's submit callback (deep inside a generation) can store the
 *  provider task id on the right job without threading a handle through. */
const currentJob = new AsyncLocalStorage<JobHandle>();

/** Called the moment a provider accepts a job: stores its task id (and
 *  provider/model) on the running ledger job. No-op outside a ledger job. */
export function recordProviderTask(taskId: string, provider?: string, model?: string): void {
  const h = currentJob.getStore();
  if (!h) return;
  h.setTaskId(taskId);
  if (provider) h.setProvider(provider, model);
}

/** Outcome of one poll of a resumed task. */
export type ResumePoll = "done" | "pending";

export interface ResumeDeps {
  /** Look the task up by its stored id and, when ready, fetch + save + finish
   *  it exactly as an uninterrupted run would. Never submits. Throws on a dead task. */
  poll(job: JobRecord): Promise<ResumePoll>;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  /** Give up after this many polls (default: effectively until the provider says it is dead). */
  maxPolls?: number;
}

/** Resume every recovered job that has a provider task id: poll until the
 *  result is fetched, then complete it. Jobs run independently, so one
 *  failing never blocks the rest. */
export async function resumeRecoveredJobs(ledger: JobLedger, deps: ResumeDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.intervalMs ?? 15000;
  const maxPolls = deps.maxPolls ?? 2000;
  await Promise.all(ledger.resumable.map(async (job) => {
    for (let i = 0; i < maxPolls; i++) {
      const live = ledger.get(job.id);
      if (!live || live.state === "cancelled") return; // cancelled locally: stop fetching
      try {
        const r = await deps.poll(live);
        if (r === "done") { ledger.handle(job.id)?.succeed(); return; }
      } catch (e) {
        ledger.handle(job.id)?.fail(e instanceof Error ? e.message : String(e));
        return;
      }
      ledger.handle(job.id)?.markFetching();
      await sleep(interval);
      ledger.handle(job.id)?.markRunning();
    }
    ledger.handle(job.id)?.fail("Gave up waiting for the provider.");
  }));
}
import { isActiveJobState, jobForChannel, jobLabel, jobTargetKey } from "../shared/ipc/jobs.js";

export interface JobBeginOptions {
  productionId: string;
  kind: JobKind;
  label: string;
  shotId?: string;
  nodeId?: string;
  /** Start state. Defaults to "running" (legacy callers); the IPC wrapper
   *  records "queued" BEFORE the provider is touched. */
  initialState?: "queued" | "running";
  provider?: string;
  model?: string;
  settings?: unknown;
  origin?: "ui" | "agent";
  channel?: string;
}

/** A job's lifecycle controls. */
export interface JobHandle {
  id: string;
  markSubmitting(): void;
  markRunning(): void;
  markFetching(): void;
  /** Store the provider's task id the moment it accepts the job. */
  setTaskId(taskId: string): void;
  setProgress(percent: number): void;
  setProvider(provider: string, model?: string): void;
  succeed(): void;
  fail(error: string): void;
  cancel(): void;
}

export interface JobLedgerDeps {
  now?: () => string;
  newId?: () => string;
  /** Persist the non-terminal jobs (main wires a file; tests skip). */
  persist?: (active: JobRecord[]) => void;
  /** Jobs persisted by a previous run (crash recovery). */
  loadPersisted?: () => JobRecord[];
  /** Can this job be picked back up from its provider task id? Jobs for which
   *  this is false (or that have no task id) become `interrupted`. */
  canResume?: (job: JobRecord) => boolean;
  scheduler?: JobScheduler;
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
  /** Recovered jobs with a task id on a resumable provider (still running/fetching). */
  readonly resumable: JobRecord[];
  get(id: string): JobRecord | undefined;
  /** A lifecycle handle for an existing job (used by recovery/resume). */
  handle(id: string): JobHandle | undefined;
  /** Cancel by id (ledger-side); false if already final. */
  cancel(id: string): boolean;
  /** The main-process scheduler that owns concurrency for this ledger. */
  readonly scheduler: JobScheduler;
}

/** Run `fn` under a ledger record derived from the IPC channel — the one
 *  lifecycle every generation door shares (the renderer's IPC wrapper and
 *  the agent tools both call this), so a generation cannot bypass the
 *  ledger by entering through a different door. Non-generation channels
 *  run unwrapped. A failure records `failed` and rethrows. */
export async function runWithJobLedger<T>(
  ledger: JobLedger,
  channel: string,
  args: unknown[],
  fn: () => Promise<T> | T
): Promise<T> {
  const job = jobForChannel(channel, args);
  if (!job) return await fn();
  // Recorded BEFORE the provider is touched, with a replayable settings snapshot.
  const rec = ledger.begin({
    productionId: args[0] as string, ...job, label: jobLabel(job.kind),
    initialState: "queued", settings: args.slice(1), origin: "ui", channel,
  });
  // The job waits here, visibly `queued`, until the scheduler's constraints
  // (one per target, per-provider limit) allow it. Failure/cancel of other
  // jobs release their slots, so nothing behind them stalls.
  const release = await ledger.scheduler.acquire({
    key: jobTargetKey(job.kind, args),
    provider: ledger.get(rec.id)?.provider,
    isCancelled: () => ledger.get(rec.id)?.state === "cancelled",
  });
  if (!release) throw new Error("Generation cancelled before it started.");
  try {
    rec.markSubmitting();
    // Running under this job's handle lets the provider's submit callback
    // store the task id (recordProviderTask); fn may then flip to running.
    const result = await currentJob.run(rec, fn);
    if (ledger.get(rec.id)?.state === "cancelled") return result;
    rec.succeed();
    return result;
  } catch (e) {
    if (ledger.get(rec.id)?.state !== "cancelled") rec.fail(e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    release();
  }
}

export function createJobLedger(deps: JobLedgerDeps = {}): JobLedger {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const jobs = new Map<string, JobRecord>();
  const listeners = new Set<(snapshot: JobSnapshot) => void>();
  const interrupted: JobRecord[] = [];
  const scheduler = deps.scheduler ?? createJobScheduler();

  const persist = (): void => {
    if (!deps.persist) return;
    // Unfinished jobs, interrupted jobs and undismissed failures survive a restart.
    const keep = [...jobs.values()].filter((j) => isActiveJobState(j.state) || j.state === "interrupted" || j.state === "failed");
    deps.persist(keep);
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
    rec.finishedAt = !isActiveJobState(state) ? now() : rec.finishedAt;
    if (error !== undefined) rec.error = error;
    if (state === "succeeded") pruneTerminal(rec.productionId);
    persist();
    emit(rec.productionId);
  };

  const pruneTerminal = (productionId: string): void => {
    const finished = [...jobs.values()].filter(
      (j) => j.productionId === productionId && j.state === "succeeded"
    );
    if (finished.length <= TERMINAL_WINDOW) return;
    const drop = finished.slice(0, finished.length - TERMINAL_WINDOW);
    for (const j of drop) jobs.delete(j.id);
  };

  // Crash recovery: jobs that were running when the app died become a visible
  // terminal state instead of vanishing (or worse, spinning forever).
  // Migration: older files hold only `running` jobs with no new fields; every
  // new field is optional so they load unchanged.
  // Rules: failed rows come back as-is; interrupted stay interrupted; a job
  // with a task id on a resumable provider stays running/fetching for the
  // resume step; everything else unfinished becomes interrupted with a reason
  // and is NEVER resubmitted automatically (only the user's Retry restarts it).
  const resumable: JobRecord[] = [];
  const valid = (deps.loadPersisted?.() ?? []).filter(
    (j) => j && typeof j.id === "string" && typeof j.productionId === "string" && typeof j.state === "string"
  );
  for (const j of valid) {
    if (j.state === "failed") { jobs.set(j.id, { ...j }); continue; }
    if (j.state === "interrupted") {
      const rec = { ...j };
      jobs.set(rec.id, rec);
      interrupted.push(rec);
      continue;
    }
    if (!isActiveJobState(j.state)) continue; // succeeded/cancelled never reappear
    if ((j.state === "running" || j.state === "fetching") && j.taskId && deps.canResume?.(j)) {
      const rec = { ...j };
      jobs.set(rec.id, rec);
      resumable.push(rec);
      continue;
    }
    const reason =
      j.state === "queued" ? "Cascade closed before this was sent to the provider. It was not submitted; retry if you still want it."
      : j.state === "submitting" ? "Cascade closed while this was being sent, so it is unknown whether the provider received it. It was not resubmitted, to avoid being charged twice. Retry if you want it."
      : j.taskId ? "This provider does not support resuming, so the result could not be picked back up. It may still finish on the provider's side."
      : "Cascade closed before the provider accepted this job.";
    const rec: JobRecord = { ...j, state: "interrupted", finishedAt: now(), error: reason };
    jobs.set(rec.id, rec);
    interrupted.push(rec);
  }

  function makeHandle(rec: JobRecord): JobHandle {
    // A transition is ignored once the job is no longer active (e.g. cancelled).
    const move = (state: JobState): void => { if (isActiveJobState(rec.state)) setState(rec, state); };
    const patch = (fn: () => void): void => { if (isActiveJobState(rec.state)) { fn(); persist(); emit(rec.productionId); } };
    return {
      id: rec.id,
      markSubmitting() { move("submitting"); },
      markRunning() { move("running"); },
      markFetching() { move("fetching"); },
      // The provider accepted the job: from now on it is tracked by this id.
      setTaskId(taskId) { patch(() => { rec.taskId = taskId; if (rec.state === "submitting" || rec.state === "queued") rec.state = "running"; }); },
      setProgress(p) { patch(() => { rec.progress = Math.max(0, Math.min(100, p)); }); },
      setProvider(provider, model) { patch(() => { rec.provider = provider; if (model) rec.model = model; }); },
      succeed() { if (isActiveJobState(rec.state)) setState(rec, "succeeded"); },
      fail(error: string) { if (isActiveJobState(rec.state)) setState(rec, "failed", error.slice(0, 500)); },
      cancel() { if (isActiveJobState(rec.state)) { setState(rec, "cancelled"); scheduler.poke(); } },
    };
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
        state: opts.initialState ?? "running",
        label: opts.label,
        startedAt: now(),
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.channel ? { channel: opts.channel } : {}),
      };
      jobs.set(id, rec);
      persist();
      emit(rec.productionId);
      return makeHandle(rec);
    },
    handle(id) {
      const rec = jobs.get(id);
      return rec ? makeHandle(rec) : undefined;
    },
    get(id) { return jobs.get(id); },
    cancel(id) {
      const rec = jobs.get(id);
      if (!rec || !isActiveJobState(rec.state)) return false;
      setState(rec, "cancelled");
      scheduler.poke();
      return true;
    },
    scheduler,
    get resumable() { return [...resumable]; },
    snapshot(productionId) {
      return buildSnapshot(productionId);
    },
    dismiss(id) {
      const rec = jobs.get(id);
      if (rec && !isActiveJobState(rec.state)) {
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
