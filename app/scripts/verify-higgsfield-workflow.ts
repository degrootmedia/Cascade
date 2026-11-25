/**
 * Live end-to-end check for Higgsfield workflow support (not a unit
 * test — spends real credits: ONE image_decompose run, 2 credits).
 *
 * Run (from app/):
 *   npx tsx scripts/verify-higgsfield-workflow.ts run <evidenceDir> <sourcePng>
 * Resume an orphaned job (never resubmits):
 *   npx tsx scripts/verify-higgsfield-workflow.ts followup <evidenceDir>
 *
 * The run goes through the real seams a future Decompose node will use:
 * provider discovery/cost/submit, the job ledger (runWithJobLedger on
 * production:generateWorkflow, with an index-style pending sink), the
 * expenses ledger (recordGeneration), and the media registry — all
 * pointed at throwaway dirs inside <evidenceDir> so real user data is
 * never touched. The pending receipt is persisted on submit, so a crash
 * or timeout can be resumed with `followup` instead of re-paying.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  HiggsfieldCliProvider,
  HiggsfieldCliPendingError,
  resolveHiggsfieldCliBinary,
} from "../src/main/providers/higgsfield-cli.js";
import { setLedgerUserDataDir, recordGeneration } from "../src/main/ledger.js";
import { createJobLedger, runWithJobLedger, recordProviderTask } from "../src/main/jobs.js";
import { writeWorkflowResults } from "../src/main/pipeline.js";
import { mediaRegistryOf } from "../src/shared/media-registry.js";
import type { LedgerGenMeta, PendingWorkflowGen, Production } from "../src/shared/ipc.js";

const [phase, evidenceDir, sourcePng] = process.argv.slice(2);
if (!phase || !evidenceDir || (phase === "run" && !sourcePng)) {
  console.error("usage: verify-higgsfield-workflow.ts run <evidenceDir> <sourcePng> | followup <evidenceDir>");
  process.exit(64);
}

const PROD_ID = "wfverify1";
const SHOT_ID = "verify-shot";
const WORKFLOW = "higgsfield-cli:workflow:image_decompose";

const productionDir = path.join(evidenceDir, "production");
const userDataDir = path.join(evidenceDir, "userdata");
fs.mkdirSync(productionDir, { recursive: true });
setLedgerUserDataDir(userDataDir);

function log(msg: string): void {
  console.log(msg);
}

function makeProduction(): Production {
  return {
    meta: { id: PROD_ID, name: "Workflow Verify", folder: productionDir, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 1,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  } as unknown as Production;
}

async function main(): Promise<void> {
  const binary = await resolveHiggsfieldCliBinary();
  if (!binary) throw new Error("No spawnable higgsfield binary resolved.");
  log(`binary: ${binary}`);

  const provider = new HiggsfieldCliProvider({
    binary: () => binary,
    recorder: { onGeneration: (meta: LedgerGenMeta) => recordGeneration(meta) },
  });

  if (phase === "followup") {
    await followup(provider, binary);
    return;
  }

  log(`credits before: ${await provider.getCredits()}`);

  const choices = await provider.listWorkflowChoices();
  log(`workflows listed: ${choices.length}`);
  const dec = choices.find((c) => c.jobType === "image_decompose");
  log(`image_decompose entry: ${JSON.stringify(dec)}`);
  if (!dec) throw new Error("image_decompose missing from workflow list — aborting before any spend.");

  const schema = await provider.workflowOptions(WORKFLOW);
  log(`schema fields: ${JSON.stringify(schema?.fields.map((f) => ({ flag: f.flag, kind: f.kind, values: f.values, default: f.default })))}`);

  const cost = await provider.getWorkflowCost({ workflow: WORKFLOW, params: { mode: "granular" } });
  log(`workflow cost quote (granular): ${cost} credits`);

  const sourceBytes = fs.readFileSync(sourcePng);
  fs.copyFileSync(sourcePng, path.join(evidenceDir, "source.png"));
  const dataUrl = `data:image/png;base64,${sourceBytes.toString("base64")}`;

  const jobsFile = path.join(evidenceDir, "jobs.json");
  const ledger = createJobLedger({
    persist: (active) => fs.writeFileSync(jobsFile, JSON.stringify(active, null, 2)),
    canResume: () => true,
  });
  const pendingFile = path.join(evidenceDir, "pending.json");
  const onPending = (rec: PendingWorkflowGen | null): void => {
    // Mirror index.ts's pending sinks: bind the vendor task id to the
    // running ledger job the moment the provider accepts the job.
    if (rec?.historyId) recordProviderTask(rec.historyId, "higgsfield-cli", rec.workflow);
    if (rec) fs.writeFileSync(pendingFile, JSON.stringify(rec, null, 2));
    else fs.rmSync(pendingFile, { force: true });
  };

  const prod = makeProduction();
  const settingsSnapshot = { workflow: WORKFLOW, params: { mode: "granular" }, source: "source.png" };
  let result;
  try {
    result = await runWithJobLedger(
      ledger,
      "production:generateWorkflow",
      [PROD_ID, SHOT_ID, settingsSnapshot],
      () =>
        provider.generateWorkflow(
          prod,
          {
            workflow: WORKFLOW,
            params: { mode: "granular" },
            refs: [{ name: "source.png", dataUrl }],
            shotId: SHOT_ID,
            waitTimeoutMs: 600_000,
            onPending,
          },
          (m, l) => log(`[emit${l ? `:${l}` : ""}] ${m}`)
        )
    );
  } catch (e) {
    if (e instanceof HiggsfieldCliPendingError) {
      log(`PENDING: job ${e.jobId} outlived the wait/download. Resume with: followup ${evidenceDir}`);
      fs.writeFileSync(path.join(evidenceDir, "jobs-snapshot.json"), JSON.stringify(ledger.snapshot(PROD_ID), null, 2));
      process.exit(2);
    }
    throw e;
  }
  if (!result) throw new Error("generateWorkflow returned nothing.");
  finish(binary, prod, ledger.snapshot(PROD_ID), result.jobId, result);
  log(`credits after: ${await provider.getCredits()}`);
}

async function followup(provider: HiggsfieldCliProvider, binary: string): Promise<void> {
  const pendingFile = path.join(evidenceDir, "pending.json");
  const rec = JSON.parse(fs.readFileSync(pendingFile, "utf8")) as PendingWorkflowGen;
  log(`resuming job ${rec.historyId} (no resubmit)`);
  const prod = makeProduction();
  const deadline = Date.now() + 600_000;
  for (;;) {
    const got = await provider.recheckWorkflow(rec);
    if (got) {
      const rels = writeWorkflowResults(prod, "image_decompose", got.jobId, got.kind, got.files.map((f) => ({ bytes: f.buf, ext: f.ext })));
      const credits = (await provider.getWorkflowCost({ workflow: rec.workflow, ...(rec.params ? { params: rec.params } : {}) })) ?? undefined;
      recordGeneration({
        kind: got.kind,
        model: rec.workflow,
        resolution: "",
        ...(rec.params ? { params: rec.params } : {}),
        credits,
        at: Date.now(),
        productionId: PROD_ID,
        ...(rec.shotId ? { shotId: rec.shotId } : {}),
      });
      fs.rmSync(pendingFile, { force: true });
      const result = {
        jobId: got.jobId,
        kind: got.kind,
        files: rels.map((rel, i) => ({ rel, ext: got.files[i].ext, url: got.files[i].url })),
        resultUrls: got.resultUrls,
      };
      finish(binary, prod, null, got.jobId, result);
      log(`credits now: ${await provider.getCredits()}`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`Job ${rec.historyId} still not fetchable after 10 min.`);
    log("still running… waiting 15s");
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

function finish(
  binary: string,
  prod: Production,
  jobs: unknown,
  jobId: string,
  result: { jobId: string; kind: string; files: { rel: string; ext: string; url: string }[]; resultUrls: string[] }
): void {
  const raw = spawnSync(binary, ["generate", "get", jobId, "--json", "--no-color"], { encoding: "utf8", timeout: 60_000 });
  fs.writeFileSync(path.join(evidenceDir, "raw-generate-get.json"), raw.stdout || raw.stderr || "");
  const expensesPath = path.join(userDataDir, "ledger", `${PROD_ID}.json`);
  const expenses = fs.existsSync(expensesPath) ? JSON.parse(fs.readFileSync(expensesPath, "utf8")) : null;
  const report = {
    result,
    jobs,
    expenses,
    mediaRegistry: mediaRegistryOf(prod),
    filesOnDisk: result.files.map((f) => {
      const abs = path.join(productionDir, f.rel);
      return { rel: f.rel, bytes: fs.statSync(abs).size, abs };
    }),
  };
  fs.writeFileSync(path.join(evidenceDir, "result.json"), JSON.stringify(report, null, 2));
  log(`RESULT: ${JSON.stringify(report, null, 2)}`);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
