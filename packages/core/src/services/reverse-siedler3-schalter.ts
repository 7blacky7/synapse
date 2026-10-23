/** P18-T97: stillgelegter Kompatibilitätsleser. Historische PG-Werte bleiben erhalten.
 * Externe, versionierte Leser werden über die allgemeine Leser-Registry verwaltet. */
export async function leseReverseSiedler3Schalter(){
 return {aktiv:false,quelle:'stillgelegt' as const,bis:null,letzter_fehler:null,
  stillgelegt:true,nachfolger:'reverse leser_liste / leser_get'};
}
