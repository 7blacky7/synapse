import { Component, useEffect, useState, type ReactNode } from 'react';
import Login from './components/Login';
// P26-T22: einzige Huelle aus den P26-Modulen (die alte SynapseWorkspaceMock.tsx ist entfernt, Rueckweg ueber files versions/restore).
import SynapseWorkspace from './components/workspace/SynapseWorkspace';
import { AUTH_UNAUTHORIZED_EVENT, getAuthStatus, logout as authLogout } from './api/auth';
import { verwirfChatFensterSitzung } from './components/chat-fenster-speicher';

type AuthState = 'checking' | 'login' | 'authed';

/** P26-T22: Absturz der Arbeitsflaeche zeigt einen Hinweis statt einer leeren Seite; Fehler in der Konsole. */
class ArbeitsflaecheGrenze extends Component<{ children: ReactNode }, { fehler: string | null }> {
  state = { fehler: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { fehler: error instanceof Error ? error.message : String(error) }; }
  componentDidCatch(error: unknown) { console.error('[arbeitsflaeche] abgestuerzt', error); }
  render() {
    if (this.state.fehler === null) return this.props.children;
    return (
      <div className="synapse-boot" role="alert">
        Die Arbeitsfläche ist abgestürzt: {this.state.fehler}{' '}
        <button type="button" onClick={() => window.location.reload()}>Neu laden</button>
      </div>
    );
  }
}

function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [totpConfigured, setTotpConfigured] = useState(false);

  useEffect(() => {
    void getAuthStatus()
      .then((status) => {
        setTotpConfigured(status.totpConfigured);
        setAuthState(status.authenticated ? 'authed' : 'login');
      })
      .catch(() => {
        setTotpConfigured(false);
        setAuthState('login');
      });
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setTotpConfigured(true);
      setAuthState('login');
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  // P22-T146: Die Chatfenster-Sitzung (geladene Beitraege, Ladetiefe) endet mit Logout bzw. abgelaufener Sitzung, nicht mit F5.
  useEffect(() => {
    if (authState === 'login') verwirfChatFensterSitzung();
  }, [authState]);

  const handleLogout = async () => {
    await authLogout();
    setTotpConfigured(true);
    setAuthState('login');
  };

  if (authState === 'checking') {
    return <div className="synapse-boot">Synapse wird geöffnet …</div>;
  }

  if (authState === 'login') {
    return <Login totpConfigured={totpConfigured} onSuccess={() => setAuthState('authed')} />;
  }

  return (
    <ArbeitsflaecheGrenze>
      <SynapseWorkspace project="synapse" onLogout={handleLogout} />
    </ArbeitsflaecheGrenze>
  );
}

export default App;
