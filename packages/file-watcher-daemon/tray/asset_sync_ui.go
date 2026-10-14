package main

// P13-T27/A9: zusätzlicher Traydialog; API-Projekte werden nie automatisch gebunden.
import (
    "context"
    "fmt"
    "strings"
    "sync/atomic"
    "time"

    "fyne.io/fyne/v2"
    "fyne.io/fyne/v2/container"
    "fyne.io/fyne/v2/dialog"
    "fyne.io/fyne/v2/widget"
)

var assetSyncWindow fyne.Window

func zeigeAssetSyncFenster() {
    if assetSyncWindow!=nil{zeigeFyneFenster(assetSyncWindow);assetSyncWindow.RequestFocus();return}
    window:=myApp.NewWindow("Projekte auf diesem PC · Asset-Sync")
    assetSyncWindow=window
    ctx,cancel:=context.WithCancel(context.Background())
    window.SetOnClosed(func(){cancel();assetSyncWindow=nil})
    window.Resize(fyne.NewSize(780,620))
    // P8-T20: Esc/Strg+W schliessen; das Ankerfenster (fenster.go) haelt den Tray dabei am Leben.
    tastaturSchliessen(window,window.Close)
    summary:=widget.NewLabel("Projektliste wird von Synapse geladen …")
    summary.Wrapping=fyne.TextWrapWord
    chooser:=widget.NewSelect(nil,nil)
    details:=container.NewVBox(widget.NewLabel("Projekt auswählen"))
    var loading atomic.Bool
    var selected string
    var detailGeneration uint64
    var conflictOffset int
    var actionBusy bool
    var reload func()
    var showProject func(string)
    // P9-T30: virtuelle API-Projekte bekommen keinen Binden/Wiederherstellen-Haken.
    virtuell:=map[string]bool{"reverse-bibliothek":true}
    showProject=func(project string){
        if actionBusy{return}
        detailGeneration++
        generation:=detailGeneration
        if selected!=project{conflictOffset=0}
        offset:=conflictOffset
        selected=project
        details.Objects=[]fyne.CanvasObject{widget.NewLabel("Bindung, Transfers und Konflikte werden geladen …")}
        details.Refresh()
        go func(){
            requestCtx,stop:=context.WithTimeout(ctx,30*time.Second);defer stop()
            host,hostErr:=daemonAssetHost(requestCtx)
            mappedHost:=""
            mappingErr:=hostErr
            if mappingErr==nil{mappedHost,mappingErr=apiAssetDaemonHost(requestCtx)}
            var binding apiAssetBinding
            bindErr:=mappingErr
            if bindErr==nil{
                if mappedHost==""{bindErr=fmt.Errorf("Diesen PC zuerst ausdrücklich zuordnen")}else if mappedHost!=host{bindErr=fmt.Errorf("Zugang gehört zu einem anderen PC")}else{binding,bindErr=apiAssetProjectBinding(requestCtx,project,host)}
            }
            syncState,syncErr:=daemonAssetStatus(requestCtx,project)
            conflictPage,conflictErr:=apiAssetConflicts(requestCtx,project,offset)
            conflicts:=conflictPage.Konflikte
            // Uploadfortschritt kommt aus dem bestätigten API-Offset, Download aus A8-Metadaten.
            for i:=range syncState.Auftraege{
                job:=&syncState.Auftraege[i]
                if job.Art=="upload"&&job.Upload!=""{
                    done,total,err:=apiAssetUploadProgress(requestCtx,project,job.Upload)
                    if err==nil{job.Bytes=&done;job.Groesse=&total}
                }
            }
            var cacheErr error
            if bindErr==nil{cacheErr=saveTrayAssetBinding(project,binding)}
            fyne.Do(func(){
                if ctx.Err()!=nil||actionBusy||selected!=project||generation!=detailGeneration{return}
                rows:=[]fyne.CanvasObject{widget.NewLabelWithStyle(project,fyne.TextAlignLeading,fyne.TextStyle{Bold:true})}
                if hostErr==nil{
                    if mappingErr!=nil{
                        rows=append(rows,assetSyncLabel("PC-Zuordnung konnte nicht geladen werden: "+mappingErr.Error()))
                    }else if mappedHost==""{
                        rows=append(rows,assetSyncLabel("Dieser PC ist noch nicht bei Synapse zugeordnet: "+host+"."))
                        assign:=widget.NewButton("Diesen PC zuordnen",nil)
                        assign.OnTapped=func(){
                            if actionBusy{return}
                            actionBusy=true;chooser.Disable();assign.Disable();detailGeneration++
                            go func(){
                                actionCtx,done:=context.WithTimeout(ctx,30*time.Second);defer done()
                                err:=apiBindAssetDaemonHost(actionCtx,host)
                                fyne.Do(func(){
                                    if ctx.Err()!=nil{return}
                                    actionBusy=false;chooser.Enable()
                                    if err!=nil{dialog.ShowError(err,window);assign.Enable();return}
                                    showProject(project) // GET bestätigt Mapping und Projektbindung frisch.
                                })
                            }()
                        }
                        rows=append(rows,assign)
                    }else if mappedHost!=host{
                        rows=append(rows,assetSyncLabel("Der Zugang ist einem anderen PC zugeordnet: "+mappedHost+". Dieser PC ist "+host+"."))
                    }
                }
                bindCheck:=widget.NewCheck("Auf diesem PC binden / wiederherstellen",nil)
                known:=bindErr==nil&&binding.Bound!=nil
                bound:=known&&*binding.Bound
                bindCheck.SetChecked(bound)
                if !known{
                    bindCheck.Disable()
                    rows=append(rows,assetSyncLabel("Bindung nicht bestätigt: "+bindErr.Error()+"\nDer lokale Cache löst keine Wiederherstellung aus."))
                }else{
                    rows=append(rows,assetSyncLabel("PC: "+host+" · Nur diese ausdrückliche Bindung erlaubt Wiederherstellen."))
                }
                var changing bool
                bindCheck.OnChanged=func(wanted bool){
                    if changing||actionBusy||!known{return}
                    changing=true;actionBusy=true;chooser.Disable();bindCheck.Disable()
                    go func(){
                        actionCtx,done:=context.WithTimeout(ctx,30*time.Second);defer done()
                        err:=apiSetAssetProjectBinding(actionCtx,project,host,wanted)
                        fyne.Do(func(){
                            if ctx.Err()!=nil{return}
                            changing=true;bindCheck.SetChecked(bound);changing=false;actionBusy=false;chooser.Enable()
                            if err!=nil{dialog.ShowError(err,window);bindCheck.Enable();return}
                            showProject(project) // Zustand erneut vom Server holen, nicht optimistisch cachen.
                        })
                    }()
                }
                if virtuell[project]{
                    rows=append(rows,assetSyncLabel("Virtuelles API-Projekt: lebt nur auf der Synapse-API und wird nie an einen PC gebunden oder wiederhergestellt."))
                }else{
                    rows=append(rows,bindCheck)
                }
                // P9-T30: "Von diesem PC entfernen" — nur fuer den bestaetigt zugeordneten eigenen PC.
                if hostErr==nil&&mappingErr==nil&&mappedHost!=""&&mappedHost==host{
                    remove:=widget.NewButton("Von diesem PC entfernen",nil)
                    remove.OnTapped=func(){
                        if actionBusy{return}
                        actionBusy=true;chooser.Disable();remove.Disable();detailGeneration++
                        go func(){
                            actionCtx,done:=context.WithTimeout(ctx,30*time.Second);defer done()
                            vorschau,err:=apiAssetHostLoesen(actionCtx,project,host,true)
                            fyne.Do(func(){
                                if ctx.Err()!=nil{return}
                                if err!=nil{actionBusy=false;chooser.Enable();remove.Enable();dialog.ShowError(err,window);return}
                                dialog.ShowConfirm("Von diesem PC entfernen",assetSyncHostLoesenText(vorschau)+"\n\nJetzt von diesem PC entfernen?",func(ok bool){
                                    if !ok{actionBusy=false;chooser.Enable();remove.Enable();return}
                                    go func(){
                                        runCtx,stop:=context.WithTimeout(ctx,30*time.Second);defer stop()
                                        ergebnis,err:=apiAssetHostLoesen(runCtx,project,host,false)
                                        fyne.Do(func(){
                                            if ctx.Err()!=nil{return}
                                            actionBusy=false;chooser.Enable()
                                            if err!=nil{remove.Enable();dialog.ShowError(err,window);return}
                                            dialog.ShowInformation("Von diesem PC entfernt",assetSyncHostLoesenText(ergebnis),window)
                                            showProject(project)
                                        })
                                    }()
                                },window)
                            })
                        }()
                    }
                    rows=append(rows,remove)
                }
                // P9-T31: Löschen nur mit rechnergebundenem Lösch-Code (auch für den User); Einrichtung des Codes für diesen PC.
                if hostErr==nil&&mappingErr==nil&&mappedHost!=""&&mappedHost==host{
                    einrichten:=widget.NewButton("Lösch-Code für diesen PC einrichten …",func(){zeigeLoeschTokenEinrichten(ctx,window,nil)})
                    rows=append(rows,einrichten)
                    if !virtuell[project]{
                        loeschen:=widget.NewButton("Projekt löschen …",func(){
                            if actionBusy{return}
                            zeigeProjektLoeschen(ctx,window,project,host,func(){reload()})
                        })
                        loeschen.Importance=widget.DangerImportance
                        rows=append(rows,loeschen)
                    }
                }
                if cacheErr!=nil{rows=append(rows,assetSyncLabel("Serverbindung bestätigt; Cache konnte nicht gespeichert werden: "+cacheErr.Error()))}
                rows=append(rows,widget.NewSeparator(),widget.NewLabelWithStyle("Asset-Sync",fyne.TextAlignLeading,fyne.TextStyle{Bold:true}))
                if syncErr!=nil{rows=append(rows,assetSyncLabel(syncErr.Error()))}else{
                    rows=append(rows,assetSyncLabel("Status: "+syncState.Modus))
                    if len(syncState.Auftraege)==0{rows=append(rows,assetSyncLabel("Keine offenen Transfers gemeldet."))}
                    for _,job:=range syncState.Auftraege{
                        label:=map[string]string{"upload":"Upload","download":"Download","loeschen":"Löschen"}[job.Art]
                        if label==""{label=job.Art}
                        rows=append(rows,assetSyncLabel(label+" · "+job.Pfad))
                        if job.Fehler!=""{rows=append(rows,assetSyncLabel("Fehler: "+job.Fehler))}
                        if job.Bytes!=nil&&job.Groesse!=nil&&*job.Groesse>0&&*job.Bytes>=0&&*job.Bytes<=*job.Groesse{
                            progress:=widget.NewProgressBar();progress.SetValue(float64(*job.Bytes)/float64(*job.Groesse))
                            rows=append(rows,progress,assetSyncLabel(fmt.Sprintf("%d / %d Bytes",*job.Bytes,*job.Groesse)))
                        }else{rows=append(rows,assetSyncLabel("Fortschritt noch nicht gemeldet."))}
                    }
                }
                rows=append(rows,widget.NewSeparator(),widget.NewLabelWithStyle("Offene Asset-Konflikte",fyne.TextAlignLeading,fyne.TextStyle{Bold:true}))
                if conflictErr!=nil{rows=append(rows,assetSyncLabel(conflictErr.Error()))}else{
                    if len(conflicts)==0{rows=append(rows,assetSyncLabel("Keine offenen Konflikte auf dieser Seite gemeldet."))}
                    for _,entry:=range conflicts{
                        conflict:=entry
                        rows=append(rows,assetSyncLabel(conflict.Pfad+"\nShare: "+assetVersionText(conflict.Share)+"\nPC: "+assetVersionText(conflict.PC)))
                        apply:=widget.NewButton("PC-Fassung übernehmen",nil)
                        discard:=widget.NewButton("PC-Fassung verwerfen",nil)
                        resolve:=func(choice string){
                            if actionBusy{return}
                            actionBusy=true;chooser.Disable();apply.Disable();discard.Disable()
                            go func(){
                                actionCtx,done:=context.WithTimeout(ctx,30*time.Second);defer done()
                                err:=apiResolveAssetConflict(actionCtx,project,conflict.AssetID,choice)
                                fyne.Do(func(){
                                    if ctx.Err()!=nil{return}
                                    actionBusy=false;chooser.Enable()
                                    if err!=nil{dialog.ShowError(err,window);apply.Enable();discard.Enable();return}
                                    showProject(project)
                                })
                            }()
                        }
                        apply.OnTapped=func(){resolve("pc")}
                        discard.OnTapped=func(){resolve("share")}
                        if conflict.AssetID==""{apply.Disable();discard.Disable()}
                        rows=append(rows,container.NewHBox(apply,discard))
                    }
                    previous:=widget.NewButton("Vorherige Konflikte",func(){if actionBusy{return};conflictOffset=offset-assetConflictPageSize;if conflictOffset<0{conflictOffset=0};showProject(project)})
                    next:=widget.NewButton("Weitere Konflikte",func(){if actionBusy{return};conflictOffset=offset+len(conflicts);showProject(project)})
                    if offset==0{previous.Disable()}
                    if !conflictPage.Gekappt{next.Disable()}
                    rows=append(rows,assetSyncLabel(fmt.Sprintf("Konflikte: %d insgesamt · Seite ab %d",*conflictPage.Total,offset+1)),container.NewHBox(previous,next))
                }
                details.Objects=rows;details.Refresh()
            })
        }()
    }
    chooser.OnChanged=func(project string){if project!=""{showProject(project)}}
    reload=func(){
        if actionBusy{return}
        if !loading.CompareAndSwap(false,true){return}
        go func(){
            defer loading.Store(false)
            requestCtx,stop:=context.WithTimeout(ctx,30*time.Second);defer stop()
            list,err:=apiAssetProjects(requestCtx)
            var contract apiContractCapabilities
            if err==nil{
                if len(list.Capabilities)==0{err=fmt.Errorf("Synapse hat Asset-Sync noch nicht freigegeben")}else{
                    err=apiUnmarshalAssetCapabilities(list.Capabilities,&contract)
                }
            }
            fyne.Do(func(){
                if ctx.Err()!=nil||actionBusy{return}
                if err!=nil{summary.SetText(err.Error());chooser.Disable();return}
                summary.SetText("Projektliste von Synapse. Neue Projekte bleiben ungebunden, bis Sie das Häkchen ausdrücklich setzen.")
                virtuell=map[string]bool{"reverse-bibliothek":true}
                for _,name:=range list.VirtuelleProjekte{virtuell[name]=true}
                chooser.Options=list.Projects;chooser.Refresh();chooser.Enable()
                if len(list.Projects)==0{details.Objects=[]fyne.CanvasObject{assetSyncLabel("Keine Projekte auf dem Server vorhanden.")};details.Refresh();return}
                exists:=false;for _,name:=range list.Projects{if name==selected{exists=true;break}}
                if !exists{chooser.SetSelected(list.Projects[0])}else{showProject(selected)}
            })
        }()
    }
    content:=container.NewBorder(container.NewVBox(summary,container.NewBorder(nil,nil,nil,widget.NewButton("Neu laden",reload),chooser)),nil,nil,nil,container.NewVScroll(details))
    window.SetContent(content);zeigeFyneFenster(window);reload()
    go func(){
        ticker:=time.NewTicker(10*time.Second);defer ticker.Stop()
        for{select{case <-ctx.Done():return;case <-ticker.C:fyne.Do(func(){if ctx.Err()==nil{reload()}})}}
    }()
}
func assetSyncLabel(text string)*widget.Label{label:=widget.NewLabel(text);label.Wrapping=fyne.TextWrapWord;return label}
func assetVersionText(v apiAssetVersion)string{
    hash:=v.SHA256;if len(hash)>12{hash=hash[:12]}
    return fmt.Sprintf("Revision %s · %d Bytes · %s · %s",v.Revision,v.Groesse,v.Zeit,hash)
}
func apiUnmarshalAssetCapabilities(raw []byte,out *apiContractCapabilities)error {
    parsed,err:=apiParseContract(raw,map[string]bool{"asset_sync":true})
    if err!=nil{return err}
    if parsed==nil||parsed.ContractVersion!=1{return fmt.Errorf("Asset-Sync-Vertrag ist noch nicht verfügbar")}
    *out=*parsed
    for _,feature:=range parsed.Features{if strings.EqualFold(feature,"asset_sync"){return nil}}
    return fmt.Errorf("Synapse hat Asset-Sync noch nicht freigegeben")
}
