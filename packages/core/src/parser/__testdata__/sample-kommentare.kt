package demo

// OFFEN [BETRIEB]: BASE_URL fest auf Emulator-Host
// zweite Zeile direkt darunter
const val BASE_URL = "http://10.0.2.2:8080/api" // nachgestellt
val raw = """
    // kein Kommentar im Raw-String
    /* auch keiner */ ${ wert /* echter Kommentar im Template */ }
"""
val c = '"' // nach Char-Literal
val s = "a \" // noch String"
/* aussen /* innen */ """ weiter aussen */
// nach verschachteltem Block
/**
 * KDoc Titel
 * @param x
 */
fun f(x: Int) = x // TODO: aufraeumen
val t = "${"verschachtelt // kein Kommentar"}"
// VOR AUSLIEFERUNG: pruefen
