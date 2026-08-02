/**
 * MODUL: Fabrik der Wrapper-Zugriffsschicht
 * ZWECK: Entscheidet einmal beim Start, welcher Weg benutzt wird.
 *
 * SYNAPSE_WRAPPER_TRANSPORT:
 *   nicht gesetzt / 'pg'  -> PgTransport (das bisherige Verhalten, VORGABE)
 *   'api'                 -> ApiTransport (HTTP gegen die synapse-api)
 *
 * ⚠️ Ein Wrapper ist ein abgekoppelter Prozess, der seinen Code beim Start laedt.
 * Er wechselt den Weg also erst beim naechsten Spawn; laufende Wrapper arbeiten
 * tagelang mit dem Weg weiter, mit dem sie gestartet wurden.
 */

import { ApiTransport } from './api.js'
import { PgTransport } from './pg.js'
import type { TransportUmgebung, WrapperTransport } from './typen.js'

export function erzeugeTransport(umgebung: TransportUmgebung): WrapperTransport {
  const roh = (process.env.SYNAPSE_WRAPPER_TRANSPORT ?? '').trim().toLowerCase()

  if (roh === 'api') return new ApiTransport(umgebung)

  if (roh !== '' && roh !== 'pg') {
    // Ein Tippfehler wuerde sonst stillschweigend 'pg' bedeuten — und wer 'api'
    // bestellt hat, saehe einen voellig normal laufenden Wrapper und wuesste nie,
    // dass sein Schalter nie gegriffen hat.
    umgebung.log(
      'SYNAPSE_WRAPPER_TRANSPORT="%s" ist unbekannt — es gibt nur "pg" und "api". Ich nehme "pg".',
      roh,
    )
  }

  return new PgTransport(umgebung)
}

export { ApiTransport } from './api.js'
export { PgTransport } from './pg.js'
export * from './typen.js'
export { BilanzWaechter, Buchhaltung } from './zaehler.js'
