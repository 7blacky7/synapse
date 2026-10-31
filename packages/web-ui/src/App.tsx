import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import Login from './components/Login';
import SynapseWorkspaceMock from './components/SynapseWorkspaceMock';
import { AUTH_UNAUTHORIZED_EVENT, getAuthStatus, logout as authLogout } from './api/auth';
import { verwirfChatFensterSitzung } from './components/chat-fenster-speicher';
// P22-T222: Umschalter alte/neue Huelle (Produkt-Schalter web_ui_neue_oberflaeche, Standard AUS = alt).
import { leseOberflaeche, merkeTabWahl, setzeOberflaeche, type OberflaecheStand } from './components/oberflaeche-wahl';
import './oberflaeche-umschalter.css';

// Neue Huelle nur laden, wenn sie gewaehlt ist (eigenes Bundle, die alte bleibt unveraendert).
const SynapseWorkspace = lazy(() => import('./components/workspace/SynapseWorkspace'));

type AuthState = 'checking' | 'login' | 'authed';
const PROJEKT = 'synapse';

/** P22-T222: Absturz der neuen Huelle -> zurueck auf die alte (nur dieser Tab), Fehler in der Konsole. */
class NeueOberflaecheGrenze extends Component<{ children: ReactNode; onAbsturz: (fehler: string) => void }, { kaputt: boolean }> {
  state = { kaputt: false };
  static getDerivedStateFromError() { return { kaputt: true }; }
  componentDidCatch(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    console.error('[oberflaeche] neue Huelle abgestuerzt, zurueck auf alt', error);
    this.props.onAbsturz(text);
  }
  render() { return this.state.kaputt ? <div className="oberflaeche-absturz">Neue Oberfläche abgestürzt, die alte wird geladen …</div> : this.props.children; }
}

function OberflaecheChip({ onZurueck }: { onZurueck: () => void }) {
  const [fehler, setFehler] = useState('');
  const [busy, setBusy] = useState(false);
  const zurueck = async () => {
    setBusy(true);
    const f = await setzeOberflaeche(PROJEKT, false, 'Web-UI: zurueck zur alten Oberflaeche (Chip, P22-T222)');
    setBusy(false);
    if (f) { setFehler(f); merkeTabWahl('alt'); }
    onZurueck();
  };
  return (
    <div className="oberflaeche-chip" role="status">
      <span>Neue Oberfläche (Test)</span>
      <button type="button" disabled={busy} onClick={() => void zurueck()}>zur alten</button>
      {fehler && <span className="fehler" title="Schalter nicht gesetzt, alte Oberfläche nur in diesem Tab">{fehler}</span>}
    </div>
  );
}

function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [totpConfigured, setTotpConfigured] = useState(false);
  const [oberflaeche, setOberflaeche] = useState<OberflaecheStand | null>(null);

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

  // P22-T222: Huelle erst nach Login waehlen (der Schalter-Abruf braucht die Sitzung).
  useEffect(() => {
    if (authState !== 'authed') return;
    void leseOberflaeche(PROJEKT).then((stand) => {
      console.debug('[oberflaeche]', stand);
      setOberflaeche(stand);
    });
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

  if (!oberflaeche) {
    return <div className="synapse-boot">Synapse wird geöffnet …</div>;
  }

  if (oberflaeche.oberflaeche === 'neu') {
    const aufAlt = (quelle: OberflaecheStand['quelle'], fehler: string | null) => {
      if (quelle === 'absturz') merkeTabWahl('alt');
      const stand: OberflaecheStand = { oberflaeche: 'alt', quelle, letzter_fehler: fehler };
      console.debug('[oberflaeche]', stand);
      setOberflaeche(stand);
    };
    return (
      <NeueOberflaecheGrenze onAbsturz={(f) => aufAlt('absturz', f)}>
        <Suspense fallback={<div className="synapse-boot">Neue Oberfläche wird geladen …</div>}>
          <SynapseWorkspace project={PROJEKT} onLogout={handleLogout} />
        </Suspense>
        <OberflaecheChip onZurueck={() => aufAlt('produkt-schalter', null)} />
      </NeueOberflaecheGrenze>
    );
  }

  return <SynapseWorkspaceMock project={PROJEKT} onLogout={handleLogout} />;
}

export default App;
