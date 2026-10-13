package main

// P13-T27/A9: synthetic p13_a9, loopback/Fake-API only; no production API or DB.
import (
    "bytes"
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "reflect"
    "runtime"
    "strings"
    "testing"
)

type a9RoundTrip func(*http.Request) (*http.Response, error)
func (f a9RoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func a9Response(r *http.Request, status int, body io.Reader) *http.Response {
    return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(body), Request: r}
}
func a9Setup(t *testing.T, transport http.RoundTripper) {
    t.Helper()
    setupApiBaseConfig(t, map[string]string{"synapse_api_url": "https://secondary.test"})
    t.Setenv("SYNAPSE_API_URL", "https://primary.test")
    t.Setenv("SYNAPSE_API_FALLBACK_URL", "https://fallback.test")
    t.Setenv("SYNAPSE_API_TOKEN", "p13_a9-test-only")
    old := apiHttpClient
    apiHttpClient = &http.Client{Transport: transport}
    t.Cleanup(func() { apiHttpClient = old })
}
type a9Writer struct { io.Writer; closeErr error }
func (w a9Writer) Close() error { return w.closeErr }
type a9BadReader struct{}
func (a9BadReader) Read([]byte) (int,error) { return 0, errors.New("synthetic source failure") }
type a9BadWriter struct{ short bool }
func (w a9BadWriter) Write(p []byte) (int,error) {
    if w.short { return 0,nil }
    return 0,errors.New("synthetic disk failure")
}
type a9BrokenNetwork struct{ emitted bool }
func (r *a9BrokenNetwork) Read(p []byte)(int,error) {
    if !r.emitted { r.emitted=true; p[0]='x'; return 1,nil }
    return 0,io.ErrUnexpectedEOF
}
type a9Pattern struct{ left int64; value byte }
func (r *a9Pattern) Read(p []byte)(int,error) {
    if r.left==0 { return 0,io.EOF }
    n:=len(p); if int64(n)>r.left { n=int(r.left) }
    value:=r.value;if value==0{value=7}
    for i:=0;i<n;i++ { p[i]=value }
    r.left-=int64(n)
    return n,nil
}
type a9Sink struct{ n int64; bad bool }
func (s *a9Sink) Write(p []byte)(int,error) {
    for _,b:=range p { if b!=7 { s.bad=true } }
    s.n+=int64(len(p)); return len(p),nil
}
func TestA9LargeLoopbackStreaming(t *testing.T) {
    const size int64=64*1024*1024
    uploadedCh:=make(chan int64,1)
    server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
        if r.URL.Path!="/api/projects/p13_a9/assets/bytes" || r.Header.Get("Authorization")!="Bearer p13_a9-test-only" ||
            r.Header.Get("X-Synapse-Contract-Version")!="1" || r.ContentLength!=size {
            t.Errorf("unexpected loopback request %s length=%d",r.URL.Path,r.ContentLength)
            w.WriteHeader(400); return
        }
        uploaded,err:=io.Copy(io.Discard,r.Body)
        if err!=nil { t.Errorf("loopback upload: %v",err); return }
        uploadedCh<-uploaded
        w.Header().Set("Content-Length",fmt.Sprint(size))
        value:=byte(7)
        if os.Getenv("SYNAPSE_A9_NEGATIVE_CONTROL")=="1"{value=8}
        _,err=io.Copy(w,&a9Pattern{left:size,value:value})
        if err!=nil { t.Errorf("loopback response: %v",err) }
    }))
    defer server.Close()
    a9Setup(t,a9RoundTrip(func(r *http.Request)(*http.Response,error){
        if strings.HasPrefix(r.URL.String(),server.URL+"/") { return http.DefaultTransport.RoundTrip(r) }
        return nil,errors.New("test forbids external network")
    }))
    t.Setenv("SYNAPSE_API_URL",server.URL)
    sink:=&a9Sink{}
    runtime.GC()
    var before,after runtime.MemStats
    runtime.ReadMemStats(&before)
    result,err:=apiRequestBinaryWithToken(context.Background(),apiBinaryRequest{
        Method:http.MethodPost,Path:"/api/projects/p13_a9/assets/bytes",ContentLength:size,
        Header:http.Header{"Authorization":[]string{"Bearer deliberately-wrong"}},
        OpenBody:func()(io.ReadCloser,error){return io.NopCloser(&a9Pattern{left:size}),nil},
        OpenDestination:func()(io.WriteCloser,error){return a9Writer{Writer:sink},nil},
    },apiToken())
    runtime.ReadMemStats(&after)
    var uploaded int64
    if err==nil{select{case uploaded=<-uploadedCh:default:t.Fatal("loopback upload not confirmed")}}
    if err!=nil || result.Uploaded!=size || uploaded!=size || result.Downloaded!=size || sink.n!=size || sink.bad {
        t.Fatalf("stream result=%+v source=%d sink=%d bad=%v err=%v",result,uploaded,sink.n,sink.bad,err)
    }
    allocated:=after.TotalAlloc-before.TotalAlloc
    if allocated>16*1024*1024 { t.Fatalf("ReadAll regression: %d allocated for 64MiB",allocated) }
    t.Logf("64MiB upload+download, allocated=%d bytes",allocated)
}
func TestA9StatusAndTransportFallback(t *testing.T) {
    for _,status:=range []int{301,302,307,308,400,401,403,404,409,413,429,500,502,503,599,600} {
        t.Run(fmt.Sprint(status),func(t *testing.T){
            var hosts []string
            opened:=0
            a9Setup(t,a9RoundTrip(func(r *http.Request)(*http.Response,error){
                hosts=append(hosts,r.URL.Host)
                if r.Body!=nil { _,_ = io.Copy(io.Discard,r.Body) }
                code:=200; if len(hosts)==1 { code=status }
                response:=a9Response(r,code,strings.NewReader("ok"))
                response.Header.Set("Location","https://redirect-must-not-be-followed.test")
                return response,nil
            }))
            _,err:=apiStreamBinary(context.Background(),apiBinaryRequest{Method:"POST",Path:"/p13_a9",ContentLength:2,
                OpenBody:func()(io.ReadCloser,error){opened++;return io.NopCloser(strings.NewReader("ok")),nil}},apiToken())
            fallback:=status>=500&&status<600
            if fallback {
                if err!=nil || !reflect.DeepEqual(hosts,[]string{"primary.test","secondary.test"}) || opened!=2 { t.Fatalf("fallback hosts=%v opened=%d err=%v",hosts,opened,err) }
            }else{
                var httpErr *apiBinaryHTTPError
                if !errors.As(err,&httpErr)||httpErr.Status!=status||len(hosts)!=1||opened!=1 { t.Fatalf("real HTTP error hosts=%v opened=%d err=%v",hosts,opened,err) }
            }
        })
    }
    t.Run("transport",func(t *testing.T){
        calls:=0
        a9Setup(t,a9RoundTrip(func(r *http.Request)(*http.Response,error){
            calls++; if calls==1 { return nil,errors.New("synthetic offline") }
            return a9Response(r,200,strings.NewReader("ok")),nil
        }))
        result,err:=apiStreamBinary(context.Background(),apiBinaryRequest{Method:"GET",Path:"/p13_a9"},apiToken())
        if err!=nil||calls!=2||result.Base!="https://secondary.test" { t.Fatalf("transport calls=%d result=%+v err=%v",calls,result,err) }
    })
}
func TestA9LocalFailuresDoNotRetry(t *testing.T) {
    for _,kind:=range []string{"source-open","source-read","source-short","source-long","target-open","target-write","target-short","target-close"} {
        t.Run(kind,func(t *testing.T){
            calls:=0
            a9Setup(t,a9RoundTrip(func(r *http.Request)(*http.Response,error){
                calls++
                if r.Body!=nil { if _,err:=io.Copy(io.Discard,r.Body);err!=nil { return nil,err } }
                return a9Response(r,200,strings.NewReader("result")),nil
            }))
            input:=apiBinaryRequest{Method:"POST",Path:"/p13_a9",ContentLength:2}
            switch kind {
            case "source-open": input.OpenBody=func()(io.ReadCloser,error){return nil,errors.New("open failed")}
            case "source-read": input.OpenBody=func()(io.ReadCloser,error){return io.NopCloser(a9BadReader{}),nil}
            case "source-short": input.OpenBody=func()(io.ReadCloser,error){return io.NopCloser(strings.NewReader("x")),nil}
            case "source-long": input.OpenBody=func()(io.ReadCloser,error){return io.NopCloser(strings.NewReader("xxx")),nil}
            case "target-open": input.OpenDestination=func()(io.WriteCloser,error){return nil,errors.New("open failed")}
            case "target-write": input.OpenDestination=func()(io.WriteCloser,error){return a9Writer{Writer:a9BadWriter{}},nil}
            case "target-short": input.OpenDestination=func()(io.WriteCloser,error){return a9Writer{Writer:a9BadWriter{short:true}},nil}
            case "target-close": input.OpenDestination=func()(io.WriteCloser,error){return a9Writer{Writer:io.Discard,closeErr:errors.New("sync failed")},nil}
            }
            _,err:=apiStreamBinary(context.Background(),input,apiToken())
            want:=1; if kind=="source-open" { want=0 }
            if err==nil||calls!=want { t.Fatalf("local failure retried: calls=%d err=%v",calls,err) }
        })
    }
}
func TestA9PartialDownloadUsesFreshDestination(t *testing.T) {
    calls:=0; var targets []*bytes.Buffer
    a9Setup(t,a9RoundTrip(func(r *http.Request)(*http.Response,error){
        calls++; if calls==1 { return a9Response(r,200,&a9BrokenNetwork{}),nil }
        return a9Response(r,200,strings.NewReader("complete")),nil
    }))
    result,err:=apiStreamBinary(context.Background(),apiBinaryRequest{Method:"GET",Path:"/p13_a9",
        OpenDestination:func()(io.WriteCloser,error){b:=&bytes.Buffer{};targets=append(targets,b);return a9Writer{Writer:b},nil}},apiToken())
    if err!=nil||calls!=2||len(targets)!=2||targets[0].String()!="x"||targets[1].String()!="complete"||result.Downloaded!=8 {
        t.Fatalf("fresh destination calls=%d targets=%v result=%+v err=%v",calls,targets,result,err)
    }
}
func TestA9CancellationAndPathValidation(t *testing.T) {
    calls:=0
    a9Setup(t,a9RoundTrip(func(r *http.Request)(*http.Response,error){calls++;return a9Response(r,200,strings.NewReader("")),nil}))
    ctx,cancel:=context.WithCancel(context.Background());cancel()
    if _,err:=apiStreamBinary(ctx,apiBinaryRequest{Method:"GET",Path:"/p13_a9"},"");!errors.Is(err,context.Canceled) { t.Fatal(err) }
    for _,path:=range []string{"//evil.test/a","relative","/a\r\n"} {
        if _,err:=apiStreamBinary(context.Background(),apiBinaryRequest{Method:"GET",Path:path},"");err==nil { t.Fatalf("invalid path %q accepted",path) }
    }
    if calls!=0 { t.Fatalf("invalid requests reached transport: %d",calls) }
}
func TestA9CacheUnknownFieldsAndCorruption(t *testing.T) {
    root:=t.TempDir(); path:=filepath.Join(root,"asset-sync.json")
    t.Setenv("SYNAPSE_ASSET_SYNC_CACHE_FILE",path)
    original:=[]byte(`{"future":{"v":[1,2]},"projects":{"other":{"keep":true},"p13_a9":{"plugin":"keep"}}}`)
    if err:=os.WriteFile(path,original,0600);err!=nil { t.Fatal(err) }
    bound:=true
    if err:=saveTrayAssetBinding("p13_a9",apiAssetBinding{Success:true,Hostname:"pc-a9",Bound:&bound});err!=nil { t.Fatal(err) }
    raw,err:=os.ReadFile(path);if err!=nil { t.Fatal(err) }
    var got map[string]interface{};if err=json.Unmarshal(raw,&got);err!=nil { t.Fatal(err) }
    projects:=got["projects"].(map[string]interface{})
    entry:=projects["p13_a9"].(map[string]interface{})
    if entry["plugin"]!="keep"||entry["bound"]!=true||entry["hostname"]!="pc-a9"||got["future"]==nil||projects["other"].(map[string]interface{})["keep"]!=true { t.Fatalf("unknown fields lost: %s",raw) }
    info,_:=os.Stat(path);if info.Mode().Perm()!=0600 { t.Fatalf("cache permissions %o",info.Mode().Perm()) }
    files,_:=os.ReadDir(root);if len(files)!=1 { t.Fatalf("temporary files leaked: %v",files) }
    for _,bad:=range []string{"null","[]","{broken","{\"projects\":null}"} {
        if err=os.WriteFile(path,[]byte(bad),0600);err!=nil { t.Fatal(err) }
        if err=saveTrayAssetBinding("p13_a9",apiAssetBinding{Bound:&bound});err==nil { t.Fatalf("corrupt cache accepted: %s",bad) }
        unchanged,_:=os.ReadFile(path);if string(unchanged)!=bad { t.Fatal("corrupt cache overwritten") }
    }
}
func TestA9HostBindingProjectsAndConflictAPI(t *testing.T) {
    mapped:="";bound:=false;var methods []string; var choices []string; var offsets []int
    a9Setup(t,a9RoundTrip(func(r *http.Request)(*http.Response,error){
        if r.Header.Get("Authorization")!="Bearer p13_a9-test-only"||r.Header.Get("X-Synapse-Contract-Version")!="1" { t.Fatal("credentials/contract missing") }
        methods=append(methods,r.Method+" "+r.URL.Path)
        out:=map[string]interface{}{"success":true}
        switch r.URL.Path {
        case "/api/projects":
            out["projects"]=[]string{"p13_a9"};out["capabilities"]=map[string]interface{}{"contractVersion":1,"features":[]string{"asset_sync"}}
        case "/api/project-init/restore/host-binding":
            if r.Method=="POST" { var in struct{Hostname string};if err:=json.NewDecoder(r.Body).Decode(&in);err!=nil { t.Fatal(err) };mapped=in.Hostname }
            if mapped=="" { out["hostname"]=nil }else{out["hostname"]=mapped}
        case "/api/projects/p13_a9/host-binding":
            if r.URL.Query().Get("hostname")!="pc-a9" { t.Fatal("wrong host query") }
            if r.Method=="DELETE" { bound=false }
            out["hostname"]=mapped;out["bound"]=bound
        case "/api/projects/p13_a9/restore-existing":
            var in struct{Hostname string};if err:=json.NewDecoder(r.Body).Decode(&in);err!=nil||in.Hostname!="pc-a9" { t.Fatal("wrong restore body") }
            bound=true;out["hostname"]=mapped;out["job_id"]="synthetic"
        case "/mcp/messages":
            var in struct{Method string;Params struct{Name string;Arguments map[string]interface{}}}
            if err:=json.NewDecoder(r.Body).Decode(&in);err!=nil { t.Fatal(err) }
            if in.Method!="tools/call"||in.Params.Name!="asset_intel"||in.Params.Arguments["project"]!="p13_a9" { t.Fatal("wrong tool envelope") }
            args:=in.Params.Arguments
            if args["action"]=="konflikte" {
                offset:=int(args["offset"].(float64));offsets=append(offsets,offset)
                if args["limit"]!=float64(25) { t.Fatal("wrong paging limit") }
                out["konflikte"]=[]interface{}{map[string]interface{}{"id":"41","asset_id":"7","file_path":"asset.png","pc":map[string]interface{}{"revision":"3","groesse":2},"share":map[string]interface{}{"revision":"4","groesse":3}}}
                out["total"]=26;out["gekappt"]=offset==0
            }else{
                if args["action"]!="konflikt_loesen"||args["asset_id"]!="7" { t.Fatal("wrong conflict resolution") }
                choices=append(choices,args["wahl"].(string))
            }
            out=map[string]interface{}{"jsonrpc":"2.0","id":"tray-assets","result":map[string]interface{}{"structuredContent":out}}
        default: t.Fatalf("unexpected API route %s",r.URL.Path)
        }
        raw,_:=json.Marshal(out);return a9Response(r,200,bytes.NewReader(raw)),nil
    }))
    ctx:=context.Background()
    list,err:=apiAssetProjects(ctx);if err!=nil||!reflect.DeepEqual(list.Projects,[]string{"p13_a9"}) { t.Fatalf("projects %v %v",list,err) }
    host,err:=apiAssetDaemonHost(ctx);if err!=nil||host!=""||mapped!="" { t.Fatalf("GET mutated mapping: %q %v",host,err) }
    if len(methods)!=2 { t.Fatal("project read triggered hidden writes") }
    if err=apiBindAssetDaemonHost(ctx,"pc-a9");err!=nil { t.Fatal(err) }
    host,err=apiAssetDaemonHost(ctx);if err!=nil||host!="pc-a9" { t.Fatalf("mapping %q %v",host,err) }
    binding,err:=apiAssetProjectBinding(ctx,"p13_a9",host);if err!=nil||binding.Bound==nil||*binding.Bound { t.Fatalf("initial binding %+v %v",binding,err) }
    if err=apiSetAssetProjectBinding(ctx,"p13_a9",host,true);err!=nil||!bound { t.Fatalf("restore %v",err) }
    if err=apiSetAssetProjectBinding(ctx,"p13_a9",host,false);err!=nil||bound { t.Fatalf("unbind %v",err) }
    for _,offset:=range []int{0,25} {
        page,err:=apiAssetConflicts(ctx,"p13_a9",offset)
        if err!=nil||len(page.Konflikte)!=1||page.Konflikte[0].Pfad!="asset.png"||page.Konflikte[0].Share.Revision!="4" { t.Fatalf("page %+v %v",page,err) }
    }
    for _,choice:=range []string{"pc","share"} { if err=apiResolveAssetConflict(ctx,"p13_a9","7",choice);err!=nil { t.Fatal(err) } }
    if !reflect.DeepEqual(choices,[]string{"pc","share"})||!reflect.DeepEqual(offsets,[]int{0,25}) { t.Fatalf("actions=%v offsets=%v",choices,offsets) }
}
func TestA9WrongHostAndToolErrors(t *testing.T) {
    for _,payload:=range []string{`{"success":false,"fehler":"revision_konflikt","message":"Changed"}`,`{"message":"missing success"}`} {
        t.Run(payload,func(t *testing.T){
            a9Setup(t,a9RoundTrip(func(r *http.Request)(*http.Response,error){
                if r.URL.Path=="/mcp/messages" { return a9Response(r,200,strings.NewReader(`{"result":{"structuredContent":`+payload+`}}`)),nil }
                return a9Response(r,200,strings.NewReader(`{"success":true,"hostname":"other-pc","bound":true}`)),nil
            }))
            if err:=apiBindAssetDaemonHost(context.Background(),"pc-a9");err==nil { t.Fatal("wrong host confirmed") }
            if _,err:=apiAssetProjectBinding(context.Background(),"p13_a9","pc-a9");err==nil { t.Fatal("wrong project host confirmed") }
            if err:=apiResolveAssetConflict(context.Background(),"p13_a9","7","pc");err==nil { t.Fatal("tool error accepted") }
        })
    }
}
