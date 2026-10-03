/**
 * The top-level error boundary around `Library`: a render crash reports
 * itself through `errorReport.ts` and leaves a reload prompt in place of a
 * blank page. React has no hook form of an error boundary, so this is the
 * app's one class component.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorReporter } from '../lib/errorReport.ts';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // The component stack says which part of the tree threw; the error's own stack only says where.
    const reported = error instanceof Error ? error : new Error(String(error));
    if (info.componentStack) reported.stack = `${reported.stack ?? reported.message}\n${info.componentStack}`;
    errorReporter.report('render', reported);
  }

  render() {
    if (this.state.failed)
      return (
        <div className="panel" role="alert">
          Something in the library broke. Reload the page to try again.
        </div>
      );
    return this.props.children;
  }
}
