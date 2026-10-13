package main

// A9: headless widget actions through the real dialog, API isolated to p13_a9.
import (
    "bytes"
    "encoding/json"
    "net/http"
    "sync"
    "testing"
    "time"

    "fyne.io/fyne/v2"
    "fyne.io/fyne/v2/container"
    fynetest "fyne.io/fyne/v2/test"
    "fyne.io/fyne/v2/widget"
)

type a9SerialDriver struct { fyne.Driver; mu sync.Mutex }
func (d *a9SerialDriver) DoFromGoroutine(f func(), wait bool) { d.mu.Lock();defer d.mu.Unlock();f() }
type a9SerialApp struct { fyne.App; driver *a9SerialDriver }
func (a a9SerialApp) Driver() fyne.Driver { return a.driver }
func a9Visit(object fyne.CanvasObject, visit func(fyne.CanvasObject)) {
    if object==nil{return};visit(object)
    switch o:=object.(type) {
    case *fyne.Container: for _,child:=range o.Objects{a9Visit(child,visit)}
    case *container.Scroll: a9Visit(o.Content,visit)
    }
}
func a9WaitWidget(t *testing.T, predicate func()bool) {
    t.Helper()
    until:=time.Now().Add(5*time.Second)
    for time.Now().Before(until) {
        ready:=false;fyne.DoAndWait(func(){ready=predicate()})
        if ready{return};time.Sleep(5*time.Millisecond)
    }
    t.Fatal("dialog state did not arrive")
}
func TestA9DialogExplicitHostAndProjectActions(t *testing.T) {
    previousApp:=fyne.CurrentApp()
    baseApp:=fynetest.NewApp()
    app:=a9SerialApp{App:baseApp,driver:&a9SerialDriver{Driver:baseApp.Driver()}}
    fyne.SetCurrentApp(app)
    oldApp,oldPort:=myApp,port
    myApp=app;port=12345
    var mu sync.Mutex
    mapped:="";bound:=false;writes:=0;var choices []string
    a9Setup(t,a9RoundTrip(func(r *http.Request)(*http.Response,error){
        mu.Lock();defer mu.Unlock()
        out:=map[string]interface{}{"success":true}
        if r.Method!="GET"{writes++}
        switch r.URL.Path{
        case "/api/projects":
            out["projects"]=[]string{"p13_a9"};out["capabilities"]=map[string]interface{}{"contractVersion":1,"features":[]string{"asset_sync"}}
        case "/host/status": out["online"]=true;out["hostname"]="pc-a9"
        case "/api/project-init/restore/host-binding":
            if r.Method=="POST"{var body struct{Hostname string};if err:=json.NewDecoder(r.Body).Decode(&body);err!=nil{return nil,err};mapped=body.Hostname}
            if mapped==""{out["hostname"]=nil}else{out["hostname"]=mapped}
        case "/api/projects/p13_a9/host-binding":
            out["hostname"]=mapped;out["bound"]=bound
        case "/api/projects/p13_a9/restore-existing": bound=true
        case "/projects/p13_a9/assets/status": out["modus"]="bereit";out["auftraege"]=[]interface{}{}
        case "/mcp/messages":
            var body struct{Params struct{Arguments map[string]interface{}}}
            if err:=json.NewDecoder(r.Body).Decode(&body);err!=nil{return nil,err}
            args:=body.Params.Arguments
            if args["action"]=="konflikte"{
                out["konflikte"]=[]interface{}{map[string]interface{}{"id":"1","asset_id":"7","file_path":"sample.png","pc":map[string]interface{}{"revision":"2"},"share":map[string]interface{}{"revision":"3"}}}
                out["total"]=1;out["gekappt"]=false
            }else{choices=append(choices,args["wahl"].(string))}
            out=map[string]interface{}{"result":map[string]interface{}{"structuredContent":out}}
        default: t.Errorf("unexpected dialog API %s",r.URL.Path)
        }
        raw,_:=json.Marshal(out);return a9Response(r,200,bytes.NewReader(raw)),nil
    }))
    t.Setenv("SYNAPSE_ASSET_SYNC_CACHE_FILE",t.TempDir()+"/cache.json")
    fyne.DoAndWait(zeigeAssetSyncFenster)
    t.Cleanup(func(){
        fyne.DoAndWait(func(){if assetSyncWindow!=nil{assetSyncWindow.Close()};myApp=oldApp;port=oldPort})
        baseApp.Quit()
        fyne.SetCurrentApp(previousApp)
    })
    var assign *widget.Button;var bind *widget.Check
    scan:=func(){
        assign=nil;bind=nil
        a9Visit(assetSyncWindow.Content(),func(o fyne.CanvasObject){
            if b,ok:=o.(*widget.Button);ok&&b.Text=="Diesen PC zuordnen"{assign=b}
            if c,ok:=o.(*widget.Check);ok&&c.Text=="Auf diesem PC binden / wiederherstellen"{bind=c}
        })
    }
    a9WaitWidget(t,func()bool{scan();return assign!=nil&&bind!=nil&&bind.Disabled()})
    mu.Lock();initialWrites:=writes;initialMap:=mapped;mu.Unlock()
    // The sole initial POST reads conflict metadata; no host/project mutation.
    if initialMap!=""||initialWrites!=1{t.Fatalf("selection auto-bound PC: mapping=%q writes=%d",initialMap,initialWrites)}
    fyne.DoAndWait(func(){fynetest.Tap(assign)})
    a9WaitWidget(t,func()bool{scan();return bind!=nil&&!bind.Disabled()&&!bind.Checked})
    mu.Lock();hostNow,projectNow:=mapped,bound;mu.Unlock()
    if hostNow!="pc-a9"||projectNow{t.Fatalf("host action implicitly bound project: %q %v",hostNow,projectNow)}
    fyne.DoAndWait(func(){bind.SetChecked(true)})
    a9WaitWidget(t,func()bool{scan();return bind!=nil&&!bind.Disabled()&&bind.Checked})
    mu.Lock();projectNow=bound;mu.Unlock()
    if !projectNow{t.Fatal("checkbox did not call restore API")}
    for _,label:=range []string{"PC-Fassung übernehmen","PC-Fassung verwerfen"}{
        var button *widget.Button
        a9WaitWidget(t,func()bool{
            button=nil;a9Visit(assetSyncWindow.Content(),func(o fyne.CanvasObject){if b,ok:=o.(*widget.Button);ok&&b.Text==label{button=b}})
            return button!=nil&&!button.Disabled()
        })
        fyne.DoAndWait(func(){fynetest.Tap(button)})
        a9WaitWidget(t,func()bool{
            scan()
            mu.Lock();n:=len(choices);mu.Unlock()
            expected:=1;if label=="PC-Fassung verwerfen"{expected=2}
            chooserReady:=false
            a9Visit(assetSyncWindow.Content(),func(o fyne.CanvasObject){if s,ok:=o.(*widget.Select);ok{chooserReady=!s.Disabled()}})
            return n==expected&&chooserReady&&bind!=nil&&!bind.Disabled()
        })
    }
    mu.Lock();defer mu.Unlock()
    if len(choices)!=2||choices[0]!="pc"||choices[1]!="share"{t.Fatalf("widget conflict choices %v",choices)}
}
