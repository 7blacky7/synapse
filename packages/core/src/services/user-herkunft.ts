import { AsyncLocalStorage } from 'node:async_hooks';

/** Nur am authentifizierten UI-Eingang setzen, nie aus Tool-Argumenten rekonstruieren. */
export type UserKanal = 'tray' | 'web-ui-chat' | 'web-ui-editor';
export interface UserHerkunft { akteur: 'user'; kanal: UserKanal }
const kontext = new AsyncLocalStorage<UserHerkunft>();
export function mitUserHerkunft<T>(kanal: UserKanal, ausfuehren: () => T): T {
  if (kanal !== 'tray' && kanal !== 'web-ui-chat' && kanal !== 'web-ui-editor') throw new Error('Unbekannter User-Eingang');
  return kontext.run(Object.freeze({ akteur: 'user', kanal }), ausfuehren);
}
export function aktuelleUserHerkunft(): UserHerkunft | undefined { return kontext.getStore(); }
/** Anzeige gespeicherter Herkunft; dies erzeugt keinen berechtigten Aufrufkontext. */
export function userHerkunftAusMetadata(metadata: unknown): UserHerkunft | undefined {
  if (!metadata || typeof metadata !== 'object') return;
  const h = (metadata as Record<string, unknown>).herkunft as Partial<UserHerkunft> | undefined;
  if (h?.akteur === 'user' && (h.kanal === 'tray' || h.kanal === 'web-ui-chat' || h.kanal === 'web-ui-editor')) return { akteur: 'user', kanal: h.kanal };
}
