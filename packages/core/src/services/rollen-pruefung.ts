import { aktuelleUserHerkunft } from './user-herkunft.js';
/** Koordinator wie bisher; der freie Name user ist kein Herkunftsnachweis. */
export function darfKoordinatorOderUser(wer: unknown): boolean {
  return typeof wer === 'string' && (/^(koordinator|coordinator)$/i.test(wer) || (/^user$/i.test(wer) && aktuelleUserHerkunft() !== undefined));
}
