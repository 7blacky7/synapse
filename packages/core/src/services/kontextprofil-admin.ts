import { darfKoordinatorOderUser } from './rollen-pruefung.js';

export const KONTEXTPROFIL_ADMIN_ACTIONS = [
  'kontextprofil_liste',
  'kontextprofil_setzen',
  'kontextprofil_entfernen',
] as const;

export const KONTEXTPROFIL_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  ziel: { type: 'string', description: 'Kontextprofil: Agent-ID oder Namensmuster wie luna-*' },
  kontext_budget: { type: 'number', description: 'Kontextprofil: Budget in Tokens' },
  stufe: { type: 'string', enum: ['normal', 'kompakt', 'minimal'], description: 'Kontextprofil: Ausgabestufe' },
  hinweise_aus: { type: 'array', items: { type: 'string' }, description: 'Kontextprofil: Hinweisarten abschalten' },
  hinweise_nur: { type: 'array', items: { type: 'string' }, description: 'Kontextprofil: nur diese Hinweisarten ausgeben' },
};

const PARAMETER_NAMEN = [...Object.keys(KONTEXTPROFIL_ADMIN_PARAMETER), 'grund'];

export function istKontextprofilAdminAction(action: string | undefined): boolean {
  return typeof action === 'string'
    && (KONTEXTPROFIL_ADMIN_ACTIONS as readonly string[]).includes(action);
}

/** Read-only Platzhalter bis P7-KONTEXTPROFIL-2..4; REST und stdio verwenden denselben Pfad. */
export function fuehreKontextprofilAdminAus(
  action: string,
  args: Record<string, unknown>,
  agentId?: string | null,
): Record<string, unknown> {
  const wer = agentId ?? args.agent_id;
  if (!darfKoordinatorOderUser(wer)) {
    return {
      success: false,
      status: 'forbidden',
      action,
      message: 'Kontextprofile verwalten darf nur der Koordinator oder ein nachgewiesener User.',
    };
  }

  const parameter = Object.fromEntries(
    PARAMETER_NAMEN
      .filter((name) => Object.hasOwn(args, name))
      .map((name) => [name, args[name]]),
  );
  return {
    success: false,
    status: 'coming_soon',
    action,
    message: 'Kontextprofile sind vorbereitet, aber noch nicht aktiv (P7-KONTEXTPROFIL-2..4)',
    parameter,
  };
}
