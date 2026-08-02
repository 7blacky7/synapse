/**
 * MODUL: Fabrik der Wissensschicht
 * ZWECK: Entscheidet einmal, woher das Wissen eines Spezialisten kommt.
 *
 * SYNAPSE_WISSEN_QUELLE:
 *   nicht gesetzt / 'datei' -> DateiWissen (das bisherige Verhalten, VORGABE)
 *   'api'                   -> ApiWissen (HTTP gegen die synapse-api)
 *
 * ⚠️ Ein Wrapper ist ein abgekoppelter Prozess, der seinen Code beim Start
 * laedt. Er wechselt die Quelle also erst beim naechsten Spawn; laufende Wrapper
 * arbeiten tagelang mit der Quelle weiter, mit der sie gestartet wurden.
 */

import { ApiWissen } from './api.js'
import { DateiWissen } from './datei.js'
import type { WissensQuelle, WissensUmgebung, WissensZugriff } from './typen.js'

/** Was der Schalter gerade sagt — ohne dass dafuer schon etwas gebaut werden muss. */
export function gewaehlteWissensQuelle(): WissensQuelle {
  return (process.env.SYNAPSE_WISSEN_QUELLE ?? '').trim().toLowerCase() === 'api' ? 'api' : 'datei'
}

export function erzeugeWissen(umgebung: WissensUmgebung): WissensZugriff {
  const roh = (process.env.SYNAPSE_WISSEN_QUELLE ?? '').trim().toLowerCase()

  if (roh === 'api') return new ApiWissen(umgebung)

  if (roh !== '' && roh !== 'datei') {
    // Ein Tippfehler wuerde sonst stillschweigend 'datei' bedeuten — und wer
    // 'api' bestellt hat, saehe einen normal laufenden Spezialisten und wuesste
    // nie, dass sein Schalter nie gegriffen hat.
    umgebung.log(
      'SYNAPSE_WISSEN_QUELLE="%s" ist unbekannt — es gibt nur "datei" und "api". Ich nehme "datei".',
      roh,
    )
  }

  return new DateiWissen(umgebung)
}

export { ApiWissen, MINDESTLAENGE_SYSTEM_PROMPT } from './api.js'
export { DateiWissen } from './datei.js'
export * from './typen.js'
