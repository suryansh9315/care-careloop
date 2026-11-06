import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A render crash in React unmounts the whole tree, which presents as a blank
 * white page with nothing in the console to explain it. During a live demo
 * that is the worst possible failure: indistinguishable from a dead server.
 * Showing the error, and a way back, is always better than showing nothing.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error?: Error; stack?: string }
> {
  override state: { error?: Error; stack?: string } = {};

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('CareLoop dashboard crashed:', error, info.componentStack);
    this.setState({ stack: info.componentStack ?? undefined });
  }

  override render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{ maxWidth: 720, margin: '12vh auto', padding: 24 }}>
        <div className="card card-pad">
          <h2 style={{ fontSize: 18 }}>The dashboard hit an error</h2>
          <p className="small muted" style={{ marginTop: 8 }}>
            The rest of the system is unaffected — the bridge, the call pipeline and the FHIR
            record keep running. This is a display fault only.
          </p>
          <pre className="artifact" style={{ marginTop: 16 }}>
            {error.message}
            {stack ? `\n${stack}` : ''}
          </pre>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button
              className="btn"
              onClick={() => {
                localStorage.clear();
                window.location.reload();
              }}
            >
              Sign out and reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
