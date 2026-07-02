// KIOS-7 — Einstellungen-Tab: Git-Tokens/Accounts (privat/arbeit/weitere) + Darstellung.
// 'Mein Wissen' ist jetzt ein eigener Tab (KnowledgeView). Tokens spaeter serverseitig VERSCHLUESSELT.
import { useState, useRef } from 'react';
import { useKiosTheme } from './useKiosTheme';
import './tokens.css';
import './Overview.css';

type TokenScope = 'privat' | 'arbeit' | 'weitere';
interface GitToken { id: string; label: string; scope: TokenScope; host: string; token: string; }

function mask(tok: string): string {
  const t = tok.trim();
  if (t.length <= 4) return '•'.repeat(t.length);
  return '•'.repeat(8) + t.slice(-4);
}

export default function SettingsView() {
  const [theme, setTheme] = useKiosTheme();
  const [tokens, setTokens] = useState<GitToken[]>([
    { id: 't1', label: 'GitHub privat', scope: 'privat', host: 'github.com', token: 'ghp_demo1234' },
    { id: 't2', label: 'Arbeit / Firma', scope: 'arbeit', host: 'github.com', token: 'ghp_work5678' },
  ]);
  const idc = useRef(3);
  const [tl, setTl] = useState('');
  const [tsc, setTsc] = useState<TokenScope>('privat');
  const [th, setTh] = useState('github.com');
  const [tk, setTk] = useState('');

  const addToken = () => {
    if (!tl.trim() || !tk.trim()) return;
    setTokens((x) => [...x, { id: 't' + idc.current++, label: tl.trim(), scope: tsc, host: th.trim() || 'github.com', token: tk.trim() }]);
    setTl(''); setTk(''); setTh('github.com'); setTsc('privat');
  };
  const removeToken = (id: string) => setTokens((x) => x.filter((t) => t.id !== id));

  return (
    <div className="kios-root" data-theme={theme} style={{ overflowY: 'auto' }}>
      <div className="kios-settings">
        <h1 className="kios-settings-h1">Einstellungen</h1>

        <section className="kios-cell">
          <span className="kios-stub-tag">Git-Tokens & Accounts — getrennt nach Kontext</span>
          <p className="kios-cat-hint">Mehrere Tokens moeglich (privat / arbeit / weitere). Werden spaeter serverseitig VERSCHLUESSELT gespeichert — nie als Klartext.</p>
          <div className="kios-settings-stack">
            {tokens.map((t) => (
              <div key={t.id} className="kios-tok-row">
                <span className="kios-tok-scope">{t.scope}</span>
                <span className="kios-tok-label">{t.label}</span>
                <span className="kios-tok-host">{t.host}</span>
                <code className="kios-tok-secret">{mask(t.token)}</code>
                <button type="button" className="kios-tok-del" onClick={() => removeToken(t.id)} aria-label="Token entfernen">✕</button>
              </div>
            ))}
          </div>
          <div className="kios-tok-add">
            <input value={tl} onChange={(e) => setTl(e.target.value)} placeholder="Label (z.B. GitHub privat)" aria-label="Token-Label" />
            <select value={tsc} onChange={(e) => setTsc(e.target.value as TokenScope)} aria-label="Kontext">
              <option value="privat">privat</option>
              <option value="arbeit">arbeit</option>
              <option value="weitere">weitere</option>
            </select>
            <input value={th} onChange={(e) => setTh(e.target.value)} placeholder="Host (github.com)" aria-label="Host" />
            <input value={tk} onChange={(e) => setTk(e.target.value)} type="password" placeholder="Token (ghp_…)" aria-label="Token" />
            <button type="button" onClick={addToken}>+ Token</button>
          </div>
        </section>

        <section className="kios-cell">
          <span className="kios-stub-tag">Darstellung</span>
          <div className="kios-setting-row">
            <span>Theme</span>
            <div className="kios-seg">
              <button type="button" className={theme === 'dark' ? 'is-on' : ''} onClick={() => setTheme('dark')}>Dunkel</button>
              <button type="button" className={theme === 'light' ? 'is-on' : ''} onClick={() => setTheme('light')}>Hell</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
