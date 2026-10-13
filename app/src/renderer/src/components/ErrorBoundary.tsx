import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Last-resort UI guard. Without one, a render error unmounts the whole tree and
 * leaves a blank window (indistinguishable from a crash). This shows the error
 * and offers a reload, and routes the stack to the main-process log.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // console.error is captured by the main process (console-message → main.log).
    console.error("[renderer] React render error:", error?.stack ?? String(error), info?.componentStack ?? "");
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="crash-screen">
          <h2>Cascade hit a display error</h2>
          <p>The interface hit an unexpected error. Your data is safe on disk.</p>
          <pre className="crash-detail">{String(this.state.error?.stack ?? this.state.error)}</pre>
          <div className="crash-actions">
            <button
              className="primary"
              onClick={() => {
                this.setState({ error: null });
                window.location.reload();
              }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
