import { Component, ErrorInfo, ReactNode, CSSProperties } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * Faengt Render-Crashes einer Station ab, damit nicht die GANZE App
 * schwarz wird (z.B. bei fehlerhaften Daten). Zeigt eine eingegrenzte
 * HUD-Fehlermeldung; der Rest des Control Centers laeuft weiter.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[Synapse HUD] Station-Crash abgefangen:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={styles.box}>
          <div style={styles.tag}>&#9888; STATION FAULT // RENDER ABORTED</div>
          <div style={styles.msg}>{this.state.message}</div>
          <div style={styles.hint}>
            Diese Station konnte nicht gerendert werden (vermutlich fehlerhafte
            Daten). Das Control Center laeuft weiter &mdash; wechsle Station oder
            Projekt.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const styles: Record<string, CSSProperties> = {
  box: {
    border: '1px solid var(--accent-red)',
    background: 'rgba(255, 59, 48, 0.04)',
    padding: '24px',
    margin: '20px',
    fontFamily: 'var(--font-mono)',
  },
  tag: {
    fontFamily: 'var(--font-display)',
    color: 'var(--accent-red)',
    fontWeight: 'bold',
    letterSpacing: '1px',
    marginBottom: '12px',
    fontSize: '13px',
  },
  msg: {
    color: 'var(--text-bone)',
    fontSize: '13px',
    whiteSpace: 'pre-wrap',
    marginBottom: '12px',
  },
  hint: {
    color: 'var(--text-muted)',
    fontSize: '12px',
    lineHeight: 1.5,
  },
};
