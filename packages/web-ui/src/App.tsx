import { useEffect, useState } from 'react';
import Login from './components/Login';
import SynapseWorkspaceMock from './components/SynapseWorkspaceMock';
import { AUTH_UNAUTHORIZED_EVENT, getAuthStatus, logout as authLogout } from './api/auth';

type AuthState = 'checking' | 'login' | 'authed';

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

  return <SynapseWorkspaceMock project="synapse" onLogout={handleLogout} />;
}

export default App;
