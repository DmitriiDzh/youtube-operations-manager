"use client";

import { Component, type ReactNode } from "react";

/**
 * A render-time exception in one feature (a dashboard tab, or a Settings sub-tab -- several of
 * which stay mounted simultaneously in one React tree, AGENTS.md §M) must not take down anything
 * that doesn't actually depend on that feature. Without this, React unmounts the entire tree on
 * any uncaught render error, which here means losing the whole Settings tab (including unrelated,
 * safety-critical cards like Live writes/Data API reads) or the whole app shell (nav/sign-out).
 *
 * Wrap each top-level tab's content and each Settings sub-tab's content in this. It only catches
 * render/lifecycle errors in its children (React error boundaries can't catch errors from event
 * handlers or async code -- those are each feature's own responsibility to handle).
 */
type Props = {
  children: ReactNode;
  /** Shown in the fallback message, e.g. "Settings — AI Agent". */
  label: string;
};

type State = {
  error: Error | null;
};

export class FeatureErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`[FeatureErrorBoundary] ${this.props.label} crashed:`, error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-4">
          <p className="text-sm font-medium text-red-200">
            Something went wrong in {this.props.label}.
          </p>
          <p className="mt-1 text-sm text-zinc-400">
            The rest of the app is unaffected. You can try again, or switch to another tab.
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="mt-3 rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-100 hover:bg-zinc-700"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
