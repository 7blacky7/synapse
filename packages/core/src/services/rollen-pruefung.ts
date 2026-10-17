import { aktuellerAgentAufruf, aktuellerAgentPrincipal } from './agent-bezug.js';
import { aktuelleUserHerkunft } from './user-herkunft.js';
/** Koordinator wie bisher; der freie Name user ist kein Herkunftsnachweis. */
export function darfKoordinatorOderUser(wer: unknown): boolean {
  const principal = aktuellerAgentPrincipal();
  if (aktuellerAgentAufruf()?.bezug.modus !== 'alt' && principal?.art === 'identity') return /^(koordinator|coordinator)$/i.test(principal.rolle);
  return typeof wer === 'string' && (/^(koordinator|coordinator)$/i.test(wer) || (/^user$/i.test(wer) && aktuelleUserHerkunft() !== undefined));
}
