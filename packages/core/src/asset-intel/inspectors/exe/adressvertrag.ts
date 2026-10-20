/** P21-T9: exakte, lesende Adresskarte aus den vorhandenen Exe-Inspektoren. */
export interface ExeBereich {
 art:'header'|'sektion'|'segment'|'objekt'|'seite';index:number;name:string;
 datei_offset:string|null;datei_bytes:string;va:string|null;speicher_bytes:string;
 segment?:number;segment_offset?:string;abbildung?:'linear'|'virtuell'|'kodiert'|'ungueltig';
 kopf_offset:number;kopf_bytes:number;
}
export interface ExeVerzeichnis {index:number;rva:string;bytes:string;ist_dateioffset?:boolean}
export interface ExeAdresskarte {
 format:'pe'|'elf'|'mz'|'ne'|'le'|'lx';basis:string|null;bereiche:ExeBereich[];
 verzeichnisse?:ExeVerzeichnis[];vollstaendig:boolean;warnungen:Array<{code:string;message:string}>;
}
export interface ExeAdressOption {
 maxEintraege:number;karte:(karte:ExeAdresskarte)=>void;
}
