import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  failed: boolean;
}

/** A card that throws on odd data must not white-screen the app; show a notice and keep the shell. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };
  static getDerivedStateFromError(): State {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("render failed", error, info.componentStack);
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="m-s-4 flex items-center gap-s-2 text-fg">
        <span aria-hidden="true">✖</span>
        <span>Something failed while drawing this page.</span>
        <button
          type="button"
          className="rounded border border-fg-muted bg-surface-2 px-s-3 py-s-1 hover:bg-surface-3"
          onClick={() => this.setState({ failed: false })}
        >
          Retry
        </button>
      </div>
    );
  }
}
