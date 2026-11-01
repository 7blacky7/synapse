/** P22-T256: einheitlicher Agentenvertrag für den isolierten User-Prüfplan. */
export const EDITOR_PRUEFPLAN_DEFINITION = {
 name:'editor_pruefplan',
 description:'User-Editor-Prüfpläne: liste, get (Abbildbasis/Userentwurf/aktueller Stand), zuweisen (nur Projektkoordinator), rueckmeldung (zugeteilter Prüfer). Bei abweichender Basis Konflikt melden. Bei passender Basis erstellt der zugeteilte Prüfer einen normalen files-Plan mit open_for_coedit=false, ruft editor_pruefplan plan_pruefen mit files_plan_id auf und bricht bei passend=false ab (rueckmeldung konflikt). Nur bei Übereinstimmung regulär committen; danach freigabe_bestaetigen mit dessen files_plan_id. Kein automatischer Commit.',
 inputSchema:{type:'object',properties:{
  action:{type:'string',enum:['liste','get','zuweisen','rueckmeldung','plan_pruefen','freigabe_bestaetigen']},project:{type:'string'},
  id:{type:'string',description:'UUID des User-Prüfplans'},files_plan_id:{type:'string',description:'ID des vom Prüfer regulär committeten files-Plans'},status:{type:'string',enum:['konflikt','abgelehnt']},grund:{type:'string'},pruefer_identity_id:{type:'string',description:'zuweisen: aktive Identität im Projekt'}
 },required:['action','project']}
};
