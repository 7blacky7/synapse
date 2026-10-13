package main

// P13-T27/A9: serverautoritatives Binden/Restore, Syncmetadaten und Konfliktaktionen.
import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "os"
    "path/filepath"
    "strings"
    "sync"
)

type apiAssetBinding struct {
    Success bool `json:"success"`
    Bound *bool `json:"bound"`
    Hostname string `json:"hostname"`
    PolicyRevision *int64 `json:"policyRevision,omitempty"`
}
type apiAssetTransfer struct {
    ID string `json:"id"`
    Art string `json:"art"`
    Pfad string `json:"pfad"`
    Upload string `json:"upload"`
    Bytes *int64 `json:"bytes_erledigt,omitempty"`
    Groesse *int64 `json:"groesse,omitempty"`
    Fehler string `json:"fehler,omitempty"`
    Meta struct { Groesse int64 `json:"groesse"` } `json:"meta"`
}
type apiAssetSyncStatus struct {
    Success bool `json:"success"`
    Modus string `json:"modus"`
    Bereich string `json:"bereich"`
    ZielRef string `json:"ziel_ref"`
    Auftraege []apiAssetTransfer `json:"auftraege"`
}
type apiAssetConflict struct {
    ID string `json:"id"`
    AssetID string `json:"asset_id"`
    Pfad string `json:"file_path"`
    PC apiAssetVersion `json:"pc"`
    Share apiAssetVersion `json:"share"`
}
type apiAssetVersion struct {
    Revision string `json:"revision"`
    SHA256 string `json:"sha256"`
    Groesse int64 `json:"groesse"`
    Zeit string `json:"zeit"`
}
type apiJSONBuffer struct { bytes.Buffer; Limit int }
func (b *apiJSONBuffer) Write(p []byte)(int,error) {
    if len(p)>b.Limit-b.Len(){return 0,fmt.Errorf("API-Metadaten überschreiten Grenze")}
    return b.Buffer.Write(p)
}
func (b *apiJSONBuffer) Close()error{return nil}
func apiAssetJSON(ctx context.Context,method,path string,body interface{},out interface{})error {
    var payload []byte
    var err error
    if body!=nil{payload,err=json.Marshal(body);if err!=nil{return err}}
    buffer:=&apiJSONBuffer{Limit:4*1024*1024}
    request:=apiBinaryRequest{Method:method,Path:path,ContentLength:int64(len(payload)),
        Header:http.Header{"Accept":[]string{"application/json"},"Content-Type":[]string{"application/json"}},
        OpenDestination:func()(io.WriteCloser,error){buffer.Reset();return buffer,nil}}
    if body!=nil{request.OpenBody=func()(io.ReadCloser,error){return io.NopCloser(bytes.NewReader(payload)),nil}}
    if _,err=apiRequestBinaryWithToken(ctx,request,apiToken());err!=nil{return err}
    if out==nil{return nil}
    return json.Unmarshal(buffer.Bytes(),out)
}
func apiAssetProjects(ctx context.Context)(apiProjectsResponse,error) {
    var r apiProjectsResponse
    err:=apiAssetJSON(ctx,http.MethodGet,"/api/projects",nil,&r)
    if err==nil&&!r.Success{err=fmt.Errorf("Projektliste wurde abgelehnt")}
    return r,err
}
// A10: vorhandener Ausweis -> explizit bestätigter OS-Host, niemals das Tokenlabel.
type apiAssetDaemonBinding struct {
    Success bool `json:"success"`
    Hostname *string `json:"hostname"`
}
func apiAssetDaemonHost(ctx context.Context)(string,error) {
    var r apiAssetDaemonBinding
    err:=apiAssetJSON(ctx,http.MethodGet,"/api/project-init/restore/host-binding",nil,&r)
    if err!=nil{return "",err}
    if !r.Success{return "",fmt.Errorf("PC-Zuordnung wurde nicht bestätigt")}
    if r.Hostname==nil{return "",nil}
    if strings.TrimSpace(*r.Hostname)==""{return "",fmt.Errorf("Server meldet einen ungültigen PC")}
    return *r.Hostname,nil
}
func apiBindAssetDaemonHost(ctx context.Context,host string)error {
    if strings.TrimSpace(host)==""||host=="unknown"{return fmt.Errorf("PC-Identität fehlt")}
    var r apiAssetDaemonBinding
    err:=apiAssetJSON(ctx,http.MethodPost,"/api/project-init/restore/host-binding",map[string]interface{}{"hostname":host},&r)
    if err==nil&&(!r.Success||r.Hostname==nil||*r.Hostname!=host){err=fmt.Errorf("Server hat diesen PC nicht zugeordnet")}
    return err
}
func apiAssetProjectBinding(ctx context.Context,project,host string)(apiAssetBinding,error) {
    var r apiAssetBinding
    err:=apiAssetJSON(ctx,http.MethodGet,"/api/projects/"+urlSeg(project)+"/host-binding?hostname="+urlSeg(host),nil,&r)
    if err==nil&&(!r.Success||r.Bound==nil||r.Hostname!=host){err=fmt.Errorf("Server meldet keine bestätigte Projektbindung für diesen PC")}
    return r,err
}
func apiSetAssetProjectBinding(ctx context.Context,project,host string,bound bool)error {
    method:=http.MethodDelete
    path:="/api/projects/"+urlSeg(project)+"/host-binding?hostname="+urlSeg(host)
    var body interface{}
    if bound{method=http.MethodPost;path="/api/projects/"+urlSeg(project)+"/restore-existing";body=map[string]interface{}{"hostname":host}}
    var response struct{Success bool `json:"success"`}
    err:=apiAssetJSON(ctx,method,path,body,&response)
    if err==nil&&!response.Success{err=fmt.Errorf("Server hat Projektbindung abgelehnt")}
    return err
}
func apiAssetTool(ctx context.Context,args map[string]interface{},out interface{})error {
    var response struct {
        Error *struct{Message string `json:"message"`} `json:"error"`
        Result struct {
            Structured json.RawMessage `json:"structuredContent"`
            IsError bool `json:"isError"`
            Content []struct{Type string `json:"type"`;Text string `json:"text"`} `json:"content"`
        } `json:"result"`
    }
    body:=map[string]interface{}{"jsonrpc":"2.0","id":"tray-assets","method":"tools/call",
        "params":map[string]interface{}{"name":"asset_intel","arguments":args}}
    if err:=apiAssetJSON(ctx,http.MethodPost,"/mcp/messages",body,&response);err!=nil{return err}
    if response.Error!=nil{return fmt.Errorf("%s",response.Error.Message)}
    if response.Result.IsError{return fmt.Errorf("Asset-Aktion wurde abgelehnt")}
    payload:=response.Result.Structured
    if len(payload)==0||string(payload)=="null"{
        for _,entry:=range response.Result.Content{
            if entry.Type=="text"&&json.Valid([]byte(entry.Text)){payload=[]byte(entry.Text);break}
        }
    }
    if len(payload)==0{return fmt.Errorf("Asset-Antwort enthält keine strukturierten Daten")}
    var state struct{Success *bool `json:"success"`;Error json.RawMessage `json:"error"`;Message string `json:"message"`;Fehler string `json:"fehler"`}
    if err:=json.Unmarshal(payload,&state);err!=nil{return err}
    if state.Success==nil{return fmt.Errorf("Asset-Antwort bestätigt keinen Erfolg")}
    if !*state.Success{return fmt.Errorf("Asset-Aktion wurde abgelehnt: %s %s %s",state.Fehler,state.Message,state.Error)}
    if out==nil{return nil}
    return json.Unmarshal(payload,out)
}
type apiAssetConflictPage struct {
    Konflikte []apiAssetConflict `json:"konflikte"`
    Total *int `json:"total"`
    Gekappt bool `json:"gekappt"`
}
const assetConflictPageSize=25
func apiAssetConflicts(ctx context.Context,project string,offset int)(apiAssetConflictPage,error) {
    var page apiAssetConflictPage
    if offset<0{return page,fmt.Errorf("Ungültige Konfliktseite")}
    err:=apiAssetTool(ctx,map[string]interface{}{"action":"konflikte","project":project,"limit":assetConflictPageSize,"offset":offset},&page)
    if err==nil && (page.Konflikte==nil||page.Total==nil||*page.Total<0){err=fmt.Errorf("Konfliktliste wird noch nicht vollständig angeboten")}
    if err==nil && page.Gekappt && len(page.Konflikte)==0{err=fmt.Errorf("Konfliktseite fehlt trotz weiterer Einträge")}
    return page,err
}
func apiResolveAssetConflict(ctx context.Context,project,assetID,choice string)error {
    if assetID==""||choice!="pc"&&choice!="share"{return fmt.Errorf("Ungültige Konfliktentscheidung")}
    return apiAssetTool(ctx,map[string]interface{}{"action":"konflikt_loesen","project":project,"asset_id":assetID,"wahl":choice},nil)
}
func daemonAssetJSON(ctx context.Context,route string,out interface{})error {
    req,err:=http.NewRequestWithContext(ctx,http.MethodGet,fmt.Sprintf("http://127.0.0.1:%d%s",port,route),nil)
    if err!=nil{return err}
    client:=*apiHttpClient
    client.CheckRedirect=func(_ *http.Request,_ []*http.Request)error{return http.ErrUseLastResponse}
    resp,err:=client.Do(req)
    if err!=nil{return fmt.Errorf("Lokaler Daemon nicht erreichbar")}
    defer resp.Body.Close()
    if resp.StatusCode!=http.StatusOK{return fmt.Errorf("Lokaler Daemon: HTTP %d",resp.StatusCode)}
    return json.NewDecoder(io.LimitReader(resp.Body,4*1024*1024)).Decode(out)
}
func daemonAssetHost(ctx context.Context)(string,error) {
    var r struct{Online bool `json:"online"`;Hostname string `json:"hostname"`}
    err:=daemonAssetJSON(ctx,"/host/status",&r)
    if err!=nil{return "",err}
    if !r.Online||strings.TrimSpace(r.Hostname)==""||r.Hostname=="unknown"{return "",fmt.Errorf("PC-Identität ist noch nicht verfügbar")}
    return r.Hostname,nil
}
func daemonAssetStatus(ctx context.Context,project string)(apiAssetSyncStatus,error) {
    var r apiAssetSyncStatus
    if err:=daemonAssetJSON(ctx,"/projects/"+urlSeg(project)+"/assets/status",&r);err!=nil{return r,err}
    if !r.Success{return r,fmt.Errorf("Daemon meldet noch keinen Asset-Sync")}
    return r,nil
}
func apiAssetUploadProgress(ctx context.Context,project,id string)(int64,int64,error) {
    var r struct{Success bool `json:"success"`;Upload struct{Offset int64 `json:"offset"`;Groesse int64 `json:"groesse"`} `json:"upload"`}
    err:=apiAssetJSON(ctx,http.MethodGet,"/api/projects/"+urlSeg(project)+"/assets/uploads/"+urlSeg(id),nil,&r)
    if err==nil&&!r.Success{err=fmt.Errorf("Uploadstatus fehlt")}
    return r.Upload.Offset,r.Upload.Groesse,err
}

var trayAssetCacheMu sync.Mutex
func trayAssetCachePath()string {
    if value:=strings.TrimSpace(os.Getenv("SYNAPSE_ASSET_SYNC_CACHE_FILE"));value!=""{return value}
    // Eigene Cachedatei: Daemon-Konfig wird nicht von einem zweiten Schreiber geändert.
    return filepath.Join(filepath.Dir(gpuConfigPath()),"asset-sync.json")
}
func saveTrayAssetBinding(project string,binding apiAssetBinding)error {
    trayAssetCacheMu.Lock();defer trayAssetCacheMu.Unlock()
    path:=trayAssetCachePath()
    fields:=map[string]json.RawMessage{}
    if data,err:=os.ReadFile(path);err==nil{
        if err=json.Unmarshal(data,&fields);err!=nil{return fmt.Errorf("Cache ist kein gültiges JSON: %w",err)}
    }else if !os.IsNotExist(err){return err}
    if fields==nil{return fmt.Errorf("Cache muss ein Objekt sein")}
    projects:=map[string]json.RawMessage{}
    if data,ok:=fields["projects"];ok{
        if err:=json.Unmarshal(data,&projects);err!=nil{return err}
        if projects==nil{return fmt.Errorf("Projektcache muss ein Objekt sein")}
    }
    entry:=map[string]json.RawMessage{}
    if data,ok:=projects[project];ok{
        if err:=json.Unmarshal(data,&entry);err!=nil{return err}
        if entry==nil{return fmt.Errorf("Bindungscache muss ein Objekt sein")}
    }
    for key,value:=range map[string]interface{}{"bound":binding.Bound,"hostname":binding.Hostname,"policyRevision":binding.PolicyRevision}{
        data,err:=json.Marshal(value);if err!=nil{return err};entry[key]=data
    }
    data,err:=json.Marshal(entry);if err!=nil{return err};projects[project]=data
    data,err=json.Marshal(projects);if err!=nil{return err};fields["projects"]=data
    data,err=json.MarshalIndent(fields,"","  ");if err!=nil{return err}
    if err=os.MkdirAll(filepath.Dir(path),0700);err!=nil{return err}
    temporary,err:=os.CreateTemp(filepath.Dir(path),".asset-sync-*.tmp");if err!=nil{return err}
    defer os.Remove(temporary.Name())
    if _,err=temporary.Write(data);err!=nil{temporary.Close();return err}
    if err=temporary.Sync();err!=nil{temporary.Close();return err}
    if err=temporary.Close();err!=nil{return err}
    return os.Rename(temporary.Name(),path)
}
