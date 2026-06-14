import { useState } from 'react';
import { setupTotp, confirmTotp, verifySession, TotpSetup } from '../api/auth';

interface LoginProps {
  /** true = TOTP bereits eingerichtet -> Login-Modus; false = Setup-Modus (QR). */
  totpConfigured: boolean;
  /** Nach erfolgreichem verify_2fa_session: App laden. */
  onSuccess: () => void;
}

/**
 * Login-Screen (AUTH-6).
 *
 * Zwei Modi:
 *  - SETUP  (totpConfigured === false): POST /totp/setup -> QR anzeigen ->
 *    Code aus Authenticator-App -> POST /totp/confirm -> dann Login-Code -> verify.
 *  - LOGIN  (totpConfigured === true):  6-stelligen Code -> POST /verify (verify_2fa_session).
 *
 * Nach erfolgreichem verify wird der Session-Token in localStorage abgelegt
 * (verifySession() erledigt das) und onSuccess() geladen.
 */
function Login({ totpConfigured, onSuccess }: LoginProps) {
  // Im Setup-Modus durchlaufen wir erst 'setup' (QR + confirm), dann 'verify'.
  const [phase, setPhase] = useState<'setup' | 'verify'>(totpConfigured ? 'verify' : 'setup');
  const [setupData, setSetupData] = useState<TotpSetup | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // QR-Daten genau einmal laden, sobald wir im Setup-Modus sind.
  const ensureSetupData = async () => {
    if (setupData || setupLoading) return;
    setSetupLoading(true);
    setError(null);
    try {
      const data = await setupTotp();
      setSetupData(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup fehlgeschlagen');
    } finally {
      setSetupLoading(false);
    }
  };

  // Im Setup-Modus QR direkt anstossen (Render-Trigger statt useEffect, einmalig).
  if (phase === 'setup' && !setupData && !setupLoading && !error) {
    void ensureSetupData();
  }

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirmTotp(code.trim());
      // Setup bestaetigt -> nahtlos in den Login-Schritt wechseln.
      setCode('');
      setPhase('verify');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Code ungueltig');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifySession(code.trim());
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Code ungueltig');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Synapse</h1>

        {phase === 'setup' && (
          <>
            <h2 style={styles.subtitle}>Zwei-Faktor einrichten</h2>
            {setupLoading && <p style={styles.hint}>Lade QR-Code...</p>}
            {setupData && (
              <>
                <p style={styles.hint}>In Authenticator-App scannen</p>
                <img src={setupData.qrDataUrl} alt="TOTP QR-Code" style={styles.qr} />
                <p style={styles.uri}>{setupData.otpauthUri}</p>
                <form onSubmit={handleConfirm} style={styles.form}>
                  <input
                    style={styles.input}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6-stelliger Code"
                    maxLength={6}
                    value={code}
                    onChange={(ev) => setCode(ev.target.value.replace(/\D/g, ''))}
                    autoFocus
                  />
                  <button style={styles.button} type="submit" disabled={busy || code.length < 6}>
                    {busy ? 'Pruefe...' : 'Einrichtung bestaetigen'}
                  </button>
                </form>
              </>
            )}
          </>
        )}

        {phase === 'verify' && (
          <>
            <h2 style={styles.subtitle}>Anmelden</h2>
            <p style={styles.hint}>Code aus deiner Authenticator-App eingeben</p>
            <form onSubmit={handleVerify} style={styles.form}>
              <input
                style={styles.input}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-stelliger Code"
                maxLength={6}
                value={code}
                onChange={(ev) => setCode(ev.target.value.replace(/\D/g, ''))}
                autoFocus
              />
              <button style={styles.button} type="submit" disabled={busy || code.length < 6}>
                {busy ? 'Pruefe...' : 'Anmelden'}
              </button>
            </form>
          </>
        )}

        {error && <p style={styles.error}>{error}</p>}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    background: '#1a1a2e',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
    padding: '32px 40px',
    background: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: '12px',
    width: '340px',
    maxWidth: '90vw',
  },
  title: {
    fontSize: '28px',
    fontWeight: 700,
    color: '#e94560',
    margin: 0,
  },
  subtitle: {
    fontSize: '18px',
    color: '#eaeaea',
    margin: '8px 0 0',
  },
  hint: {
    fontSize: '13px',
    color: '#aaa',
    textAlign: 'center',
    margin: 0,
  },
  qr: {
    width: '200px',
    height: '200px',
    background: '#fff',
    borderRadius: '8px',
    padding: '8px',
  },
  uri: {
    fontSize: '10px',
    color: '#666',
    wordBreak: 'break-all',
    textAlign: 'center',
    margin: 0,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    width: '100%',
  },
  input: {
    padding: '12px',
    border: '1px solid #0f3460',
    borderRadius: '6px',
    background: '#1a1a2e',
    color: '#eaeaea',
    fontSize: '20px',
    letterSpacing: '0.3em',
    textAlign: 'center',
  },
  button: {
    padding: '12px',
    border: 'none',
    borderRadius: '6px',
    background: '#e94560',
    color: '#fff',
    fontSize: '15px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  error: {
    fontSize: '13px',
    color: '#ff6b6b',
    textAlign: 'center',
    margin: 0,
  },
};

export default Login;
