/**
 * Local types for the Image Suite. The persisted/generated shapes are owned by
 * `shared/ipc/suite.ts`; this file only re-exports them so feature code imports
 * from one place (mirrors the plan's `suite-types.ts`).
 */
export type {
  SuiteEntry,
  SuiteSession,
  SuiteDraft,
  SuiteSeed,
  SuiteMode,
  SuiteGenerateRequest,
  SuiteExportTarget,
  SuiteExportResult,
} from "../../../../shared/ipc.js";
