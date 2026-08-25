import type { ApprovalRequestIpc, ApprovalDecisionIpc } from "../../../shared/ipc.js";

export function ApprovalModal({
  request,
  onDecision,
}: {
  request: ApprovalRequestIpc;
  onDecision: (d: ApprovalDecisionIpc) => void;
}) {
  const server = request.tool.includes("__") ? request.tool.split("__")[0] : null;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Cascade wants to: {request.summary}</h3>
        <pre className="approval-detail">{request.detail}</pre>
        <div className="modal-actions">
          <button className="danger" onClick={() => onDecision("deny")}>
            Deny
          </button>
          {server && (
            <button onClick={() => onDecision("allow-group-session")}>
              Allow all {server} tools this session
            </button>
          )}
          <button onClick={() => onDecision("allow-session")}>Always allow {request.tool} this session</button>
          <button className="primary" autoFocus onClick={() => onDecision("allow")}>
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
