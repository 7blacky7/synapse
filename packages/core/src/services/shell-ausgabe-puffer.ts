import {maskiereShellText} from './env-maske.js';

/** P10-T33: begrenzter LF-freier Puffer; Maskierungsregeln bleiben in env-maske. */
export const SHELL_PUFFER_GRENZE=64*1024;
export class ShellAusgabePuffer {
  private pending='';
  private verborgen:''|'zeile'|'wort'|'json'|'url'='';
  private escaped=false;
  private readonly ueberhang:number;
  constructor(private readonly werte:readonly string[],private readonly schreiben:(text:string,maskiert:number)=>void){
    this.ueberhang=werte.reduce((max,w)=>Math.max(max,w.length),256);
  }
  get gepuffert():number{return this.pending.length;}
  private ausgeben(text:string):void{
    if(!text)return;
    const safe=maskiereShellText(text,this.werte);
    this.schreiben(safe.text,safe.maskiert);
  }
  empfange(text:string):void{
    // Auch ein einzelner grosser data-Chunk darf den Puffer nicht beliebig aufblasen.
    for(let i=0;i<text.length;i+=16*1024){
      let stueck=text.slice(i,i+16*1024);
      if(this.verborgen){
        let ende=-1;
        for(let j=0;j<stueck.length;j++){
          const c=stueck[j];
          if(this.verborgen==='json'){
            if(this.escaped){this.escaped=false;continue;}
            if(c==='\\'){this.escaped=true;continue;}
            if(c==='"'){ende=j;break;}
          }else if(this.verborgen==='url'?c==='@'||/\s/.test(c):this.verborgen==='wort'?/\s/.test(c):c==='\n'){
            ende=j;break;
          }
        }
        if(ende<0)continue;
        this.verborgen='';stueck=stueck.slice(ende);
      }
      this.pending+=stueck;
      const bis=this.pending.lastIndexOf('\n');
      if(bis>=0){this.ausgeben(this.pending.slice(0,bis+1));this.pending=this.pending.slice(bis+1);}
      while(this.pending.length>SHELL_PUFFER_GRENZE+this.ueberhang)this.teilflush();
    }
  }
  private teilflush():void{
    let cut=SHELL_PUFFER_GRENZE;
    // Ein kompletter bekannter Wert, der den Schnitt kreuzt, bleibt ganz im Ueberhang.
    for(const w of this.werte){
      if(!w)continue;
      const start=this.pending.indexOf(w,Math.max(0,cut-w.length+1));
      if(start>=0&&start<cut&&start+w.length>cut)cut=start;
    }
    if(cut===0)cut=this.ueberhang;
    if(cut>0&&/[\uD800-\uDBFF]/.test(this.pending[cut-1]))cut--;
    const prefix=this.pending.slice(0,cut),rest=this.pending.slice(cut);
    // Ein offener Musterwert braucht Zustand, sonst wuerde seine Fortsetzung ohne Namen lecken.
    // Probes nutzen dieselben Regeln; kein zweiter Schluessel-/URL-Katalog.
    const marker='zzzzshellpufferprobezzzz';
    const direkt=maskiereShellText(prefix+marker);
    const quoted=maskiereShellText(prefix+marker+'"');
    const offenesJson=/"\s*:\s*"(?:\\.|[^"\\])*$/.test(prefix);
    if(!direkt.text.includes(marker)&&!offenesJson){
      this.ausgeben(prefix);
      this.verborgen=/Bearer\s+[^\s]*$/i.test(prefix)?'wort':'zeile';
      this.pending='';
      this.empfange(rest);
    }else if(offenesJson&&!quoted.text.includes(marker)){
      const safe=maskiereShellText(prefix+'"',this.werte);
      this.schreiben(safe.text.slice(0,-1),safe.maskiert);
      this.verborgen='json';this.pending='';this.empfange(rest);
    }else{
      // URL-Userinfo ist erst mit @ komplett. Im offenen Fall virtuell schliessen.
      const urlProbe=maskiereShellText(prefix+marker+'@');
      if(!urlProbe.text.includes(marker)){
        const safe=maskiereShellText(prefix+'@',this.werte);
        this.schreiben(safe.text.slice(0,-1),safe.maskiert);
        this.verborgen='url';this.pending='';this.empfange(rest);
      }else{
        this.ausgeben(prefix);this.pending=rest;
      }
    }
  }
  ende():void{this.ausgeben(this.pending);this.pending='';this.verborgen='';}
}
