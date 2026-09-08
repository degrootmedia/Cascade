/**
 * Plan-mode gate.
 *
 * Pure logic for deciding whether a tool call is allowed to run while plan
 * mode is on. Plan mode is a "research and write a written plan first" regime:
 * the agent may read and search the workspace freely, and may write its plan
 * artifacts (spec.md / plan.json under `.cascade/specs/`) so the plan becomes
 * shared mutable state the user can annotate. It may NOT edit source files or
 * run commands until the user reviews and approves the plan.
 *
 * Reads and plan-artifact writes stay allowed so the loop can actually produce
 * the plan. Everything else is gated here, so the rule is testable in isolation
 * and the agent loop just applies the returned decision.
 */
import * as path from "node:path";
import { PLAN_GATED_TOOLS } from "./types.js";
import { resolveSafe } from "./workspace.js";

/** Where plan artifacts live, relative to the workspace root. */
export const PLAN_DIR = ".cascade";
export const PLAN_SPECS_DIR = `${PLAN_DIR}/specs`;

export type PlanGate =
  | { allowed: true }
  | {
      allowed: false;
      /** A clear, one-line message the loop returns to the model. */
      message: string;
    };

function blocked(): PlanGate {
  return {
    allowed: false,
    message:
      "Plan mode is on: you may only write plan artifacts under .cascade/specs/. " +
      "Writing/editing source files and running commands are blocked until the user reviews and approves the plan.",
  };
}

/**
 * Decide whether a tool call may run under plan mode. Only the known mutating
 * tools are gated; read/search tools and MCP tools pass through. `write_file`
 * and `edit_file` are allowed when the target path is a plan artifact
 * (inside `.cascade/specs/`); everything else is blocked. `run_command` is
 * always blocked in plan mode.
 */
export function planGate(
  toolName: string,
  args: Record<string, unknown> = {},
  workspaceRoot?: string
): PlanGate {
  if (!PLAN_GATED_TOOLS.includes(toolName)) return { allowed: true };
  if (!workspaceRoot) return blocked();

  if (toolName === "write_file" || toolName === "edit_file") {
    const rel = typeof args.path === "string" ? args.path : "";
    const specsRoot = path.resolve(workspaceRoot, PLAN_SPECS_DIR);
    try {
      const abs = resolveSafe(workspaceRoot, rel);
      const relToSpecs = path.relative(specsRoot, abs);
      const insideSpecs =
        relToSpecs === "" || (!relToSpecs.startsWith("..") && !path.isAbsolute(relToSpecs));
      if (insideSpecs) return { allowed: true };
    } catch {
      // unresolvable path → blocked; the tool would fail anyway
    }
    return blocked();
  }

  // run_command
  return blocked();
}