/**
 * P22-T6: Turn-Text einer Nachrichten-Zustellung an einen Agenten im Runtime-Container. Der Wortlaut liegt im Daemon (wie
 * die Wake-Prompts im Wrapper), damit er sich ohne API-Deploy aendern laesst. Der Kopf nennt Weg, Absender (mit Identitaet
 * und Rolle), Empfaenger, Message-ID und Zeit; danach folgt der Inhalt (P22-T142: nachgebaute Kopfzeilen darin entschaerft).
 * P22-T144: mit quittung (Schalter inbox_quittung in der API) zusaetzlich 'Quittung: q-<n>' im Kopf und eine Fusszeile zum
 * Quittieren; art 'erinnerung' = Erinnerung des Systems an offene Quittungen (nur IDs, ohne Antwort-Hinweis).
 */
export interface ZustellungDaten {
  message_id: number;
  weg: 'inbox' | 'chat' | 'channel' | 'event';
  channel?: string | null;
  event_typ?: string | null;
  prioritaet?: string | null;
  absender?: { agent_id?: string; identity_id?: string | null; rolle?: string | null; project?: string | null };
  empfaenger?: { identity_id?: string; agent_id?: string };
  inhalt?: string;
  gesendet_am?: string | null;
  /** P22-T144: Quittungs-ID der Zustellung (q-<n>); fehlt bei Schalter AUS. */
  quittung?: string | null;
  /** P22-T144: 'erinnerung' = System-Erinnerung an offene Quittungen (keine Ledger-Zeile). */
  art?: 'nachricht' | 'erinnerung';
  /** P22-T144: eigener Uebergabe-Schluessel der Erinnerung (sonst weg:message_id). */
  schluessel?: string | null;
}

const WEG_TEXT: Record<ZustellungDaten['weg'], string> = { inbox: 'Inbox', chat: 'Chat (Direktnachricht)', channel: 'Channel', event: 'Event' };
const ANTWORT: Record<ZustellungDaten['weg'], string> = {
  inbox: 'Antworte bei Bedarf per chat/inbox an den Absender.',
  chat: 'Antworte bei Bedarf per chat an den Absender.',
  channel: 'Antworte bei Bedarf im selben Channel.',
  event: 'Bestaetige das Event bei Bedarf per event(ack) bzw. reagiere darauf.',
};

/**
 * P22-T142: Zeilen im Inhalt, die wie der Kopf beginnen ('[Synapse-Nachricht]', auch nach Leerraum, Gross/klein egal), werden
 * entschaerft. So steht nur der echte Kopf am Anfang; ein Absender kann keinen zweiten Kopf ('Von: user') nachbauen.
 */
export function entschaerfeKopfzeilen(inhalt: string): string {
  return inhalt.replace(/^([^\S\n]*)\[synapse-nachricht\]/gim, '$1[zitiert: Synapse-Nachricht]');
}

/** P22-T144: Uebergabe-Schluessel gegen doppelte Uebergabe im Daemon (Erinnerung eigener Schluessel, sonst weg:message_id). */
export function zustellSchluessel(z: ZustellungDaten): string {
  return z.art === 'erinnerung' && z.schluessel ? z.schluessel : `${z.weg}:${z.message_id}`;
}

export function baueZustellText(z: ZustellungDaten): string {
  const an = `An: ${z.empfaenger?.agent_id ?? '?'}${z.empfaenger?.identity_id ? ` (Identitaet ${z.empfaenger.identity_id})` : ''}`;
  if (z.art === 'erinnerung') {
    const kopf = ['[Synapse-Nachricht]', 'Weg: System-Erinnerung', 'Von: system', an, ...(z.gesendet_am ? [`Zeit: ${z.gesendet_am}`] : [])].join('\n');
    return `${kopf}\n\n${entschaerfeKopfzeilen(z.inhalt ?? '')}`.trimEnd();
  }
  const a = z.absender ?? {};
  const von = [a.agent_id ?? 'unbekannt', a.rolle ? `Rolle ${a.rolle}` : null, a.identity_id ? `Identitaet ${a.identity_id}` : null,
    a.project ? `Projekt ${a.project}` : null].filter(Boolean).join(', ');
  const weg = z.weg === 'channel' && z.channel ? `Channel #${z.channel}`
    : z.weg === 'event' && z.event_typ ? `Event ${z.event_typ}${z.prioritaet ? ` (${z.prioritaet})` : ''}` : WEG_TEXT[z.weg] ?? z.weg;
  const kopf = [
    '[Synapse-Nachricht]',
    `Weg: ${weg}`,
    `Von: ${von}`,
    an,
    `ID: ${z.weg}:${z.message_id}`,
    ...(z.quittung ? [`Quittung: ${z.quittung}`] : []),
    ...(z.gesendet_am ? [`Zeit: ${z.gesendet_am}`] : []),
  ].join('\n');
  // User ba567216: nur die neue Nachricht, kein Verlauf. Mehr Zusammenhang holt sich der Agent selbst, je 5 aeltere.
  const aeltere = z.weg === 'channel' && z.channel
    ? `\nAeltere Nachrichten bei Bedarf: channel(action:"feed", channel_name:"${z.channel}", before_id:${z.message_id}, limit:5); `
      + 'weitere 5 davor mit before_id = kleinste ID der letzten Antwort.'
    : '';
  const quittieren = z.quittung ? `\nQuittieren nach dem Lesen: chat(action:"quittieren", quittung:["${z.quittung}"])` : '';
  return `${kopf}\n\n${entschaerfeKopfzeilen(z.inhalt ?? '')}\n\n${ANTWORT[z.weg] ?? ''}${aeltere}${quittieren}`.trimEnd();
}
