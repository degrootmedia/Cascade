import type { VerificationDecisionIpc, VerificationRequestIpc } from "../../../shared/ipc.js";

/**
 * The one-time consent card for automated verification. Auto-running commands
 * is only legitimate with explicit approval, so the user chooses whether the
 * detected checks may run automatically after edits — for this workspace, this
 * chat only, or not at all.
 */
export function VerifyApprovalModal({
  request,
  onDecision,
}: {
  request: VerificationRequestIpc;
  onDecision: (d: VerificationDecisionIpc) => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Run these checks automatically after edits?</h3>
        <p className="verify-intro">
          Cascade can run the following commands after it changes files and feed any failures back to fix them.
          It will run them with the workspace as the working directory.
        </p>
        <ul className="verify-command-list">
          {request.commands.map((c, i) => (
            <li key={`${c.name}-${i}`}>
              <code>{c.argv.join(" ")}</code>
              <span className="verify-command-name">{c.name}</span>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="danger" onClick={() => onDecision("deny")}>
            Don't run
          </button>
          <button onClick={() => onDecision("session")}>This chat only</button>
          <button className="primary" autoFocus onClick={() => onDecision("workspace")}>
            Always for this folder
          </button>
        </div>
      </div>
    </div>
  );
}
