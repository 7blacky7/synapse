// KIOS — geteiltes Theme (dark/light) ueber localStorage, synchron ueber alle Tabs/Views.
import { useState, useEffect, useCallback } from 'react';

export type KiosTheme = 'dark' | 'light';
const KEY = 'kios-theme';
const EVT = 'kios-theme-change';

function read(): KiosTheme {
  try { return (localStorage.getItem(KEY) as KiosTheme) || 'dark'; } catch { return 'dark'; }
}

export function useKiosTheme(): [KiosTheme, (t: KiosTheme) => void] {
  const [theme, setThemeState] = useState<KiosTheme>(read);
  useEffect(() => {
    const h = () => setThemeState(read());
    window.addEventListener(EVT, h);
    return () => window.removeEventListener(EVT, h);
  }, []);
  const setTheme = useCallback((t: KiosTheme) => {
    try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
    setThemeState(t);
    window.dispatchEvent(new Event(EVT));
  }, []);
  return [theme, setTheme];
}
