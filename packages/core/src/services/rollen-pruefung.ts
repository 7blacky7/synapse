/** Gemeinsame bestehende Namenstreue (jev_schalten), keine neue Identitätsprüfung. */
export function darfKoordinatorOderUser(wer: unknown): boolean {
  return typeof wer === 'string' && /^(koordinator|coordinator|user)$/i.test(wer);
}
