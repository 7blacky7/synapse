import type { ChannelViewModel } from '../control-plane/view-model';
/** P22-T254: erst ungelesene Channels, dann letzte Aktivität, bei Gleichstand Name. */
export function sortiereChannelSuche(channels: ChannelViewModel[], ungelesen: Record<string, number>, suche: string): ChannelViewModel[] {
  const query=suche.toLocaleLowerCase();
  return channels.filter(c=>(c.name+' '+c.description).toLocaleLowerCase().includes(query)).sort((a,b)=> {
    const prioritaet=Number((ungelesen[b.name]||0)>0)-Number((ungelesen[a.name]||0)>0);
    return prioritaet || (Date.parse(b.letzteAktivitaet||'')||0)-(Date.parse(a.letzteAktivitaet||'')||0) || a.name.localeCompare(b.name,'de');
  });
}
