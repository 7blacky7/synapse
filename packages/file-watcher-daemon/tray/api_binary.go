package main

// P13-T27/A9: additiver Binärtransport. Basen/Token wie JSON; kein ReadAll der Datei.
import (
    "context"
    "fmt"
    "io"
    "net/http"
    "strings"
    "sync"
)

type apiBinaryRequest struct {
    Method string
    Path string
    Header http.Header
    ContentLength int64
    // Jede Wiederholung bekommt eine frische, unveränderte Quelle und ein eigenes Stagingziel.
    OpenBody func() (io.ReadCloser, error)
    OpenDestination func() (io.WriteCloser, error)
    Progress func(direction string, transferred int64)
}
type apiBinaryResult struct {
    Base string
    Status int
    Header http.Header
    Uploaded int64
    Downloaded int64
}
type apiBinaryHTTPError struct { Status int; Base string; Detail string }
func (e *apiBinaryHTTPError) Error() string { return fmt.Sprintf("HTTP %d von %s: %s",e.Status,e.Base,e.Detail) }

type apiTransferReader struct {
    Reader io.Reader
    Direction string
    Total int64
    ReadError error
    Expected int64
    mu sync.Mutex
    Progress func(string,int64)
}
func (r *apiTransferReader) Read(p []byte) (int,error) {
    n,err:=r.Reader.Read(p)
    r.mu.Lock()
    r.Total+=int64(n)
    if err==io.EOF && r.Expected>=0 && r.Total<r.Expected {err=io.ErrUnexpectedEOF}
    if r.Expected>=0 && r.Total>r.Expected {err=fmt.Errorf("Quelle überschreitet Content-Length")}
    if err!=nil && err!=io.EOF { r.ReadError=err }
    total:=r.Total
    r.mu.Unlock()
    if n>0 && r.Progress!=nil { r.Progress(r.Direction,total) }
    return n,err
}
func (r *apiTransferReader) snapshot()(int64,error){
    r.mu.Lock();defer r.mu.Unlock();return r.Total,r.ReadError
}
type apiTransferWriter struct { Writer io.Writer; WriteError error }
func (w *apiTransferWriter) Write(p []byte)(int,error) {
    n,err:=w.Writer.Write(p)
    if err==nil && n!=len(p){err=io.ErrShortWrite}
    if err!=nil { w.WriteError=err }
    return n,err
}
func apiStreamBinary(ctx context.Context, in apiBinaryRequest, token string)(apiBinaryResult,error) {
    var result apiBinaryResult
    if ctx==nil {return result,fmt.Errorf("Transfer braucht einen Kontext")}
    if !strings.HasPrefix(in.Path,"/") || strings.HasPrefix(in.Path,"//") ||
        strings.ContainsAny(in.Path,"\r\n") {return result,fmt.Errorf("Ungültiger API-Pfad")}
    if in.OpenBody!=nil && in.ContentLength<0 {return result,fmt.Errorf("Binärquelle braucht Content-Length")}
    // Kein 10s-JSON-Gesamttimeout für große Dateien; Aufrufer begrenzt per Kontext.
    client:=*apiHttpClient
    client.Timeout=0
    client.CheckRedirect=func(_ *http.Request,_ []*http.Request)error{return http.ErrUseLastResponse}
    var attempts []string
    for _,base:=range apiBases(){
        if err:=ctx.Err();err!=nil{return result,err}
        var body io.ReadCloser
        var upload *apiTransferReader
        if in.OpenBody!=nil {
            var err error
            body,err=in.OpenBody()
            if err!=nil {return result,fmt.Errorf("Quelle öffnen: %w",err)}
            if body==nil {return result,fmt.Errorf("Quelle fehlt")}
            upload=&apiTransferReader{Reader:body,Direction:"upload",Expected:in.ContentLength,Progress:in.Progress}
        }
        var reader io.Reader
        if upload!=nil {reader=upload}
        req,err:=http.NewRequestWithContext(ctx,in.Method,base+in.Path,reader)
        if err!=nil {if body!=nil{body.Close()};return result,err}
        req.Header=in.Header.Clone()
        if req.Header==nil{req.Header=make(http.Header)}
        req.Header.Set("X-Synapse-Contract-Version","1")
        if token!="" {req.Header.Set("Authorization","Bearer "+token)} else {req.Header.Del("Authorization")}
        if body!=nil {
            req.ContentLength=in.ContentLength
            if req.Header.Get("Content-Type")==""{req.Header.Set("Content-Type","application/octet-stream")}
            if in.ContentLength==0 {req.Body=http.NoBody;req.Header.Set("Content-Length","0")}
        }
        resp,err:=client.Do(req)
        if body!=nil{body.Close()}
        if ctx.Err()!=nil {if resp!=nil{resp.Body.Close()};return result,ctx.Err()}
        var uploaded int64
        if upload!=nil {
            var sourceErr error
            uploaded,sourceErr=upload.snapshot()
            if sourceErr!=nil{if resp!=nil{resp.Body.Close()};return result,fmt.Errorf("Quelle lesen: %w",sourceErr)}
        }
        if err!=nil {forgetBase(base);attempts=append(attempts,base+": Transportfehler");continue}
        result=apiBinaryResult{Base:base,Status:resp.StatusCode,Header:resp.Header.Clone()}
        result.Uploaded=uploaded
        if resp.StatusCode<200 || resp.StatusCode>=300 {
            // Fehlertext begrenzt; Binärbytes werden nie in einem JSON-Puffer gesammelt.
            var detail strings.Builder
            _,_ = io.Copy(&detail,io.LimitReader(resp.Body,4096))
            resp.Body.Close()
            if resp.StatusCode>=500 && resp.StatusCode<600 {forgetBase(base);attempts=append(attempts,fmt.Sprintf("%s: HTTP %d",base,resp.StatusCode));continue}
            return result,&apiBinaryHTTPError{Status:resp.StatusCode,Base:base,Detail:strings.TrimSpace(detail.String())}
        }
        var destination io.WriteCloser
        var target io.Writer=io.Discard
        if in.OpenDestination!=nil {
            destination,err=in.OpenDestination()
            if err!=nil{resp.Body.Close();return result,fmt.Errorf("Staging öffnen: %w",err)}
            if destination==nil{resp.Body.Close();return result,fmt.Errorf("Staging fehlt")}
            target=destination
        }
        download:=&apiTransferReader{Reader:resp.Body,Direction:"download",Expected:-1,Progress:in.Progress}
        writer:=&apiTransferWriter{Writer:target}
        result.Downloaded,err=io.CopyBuffer(writer,download,make([]byte,32*1024))
        resp.Body.Close()
        var closeErr error
        if destination!=nil{closeErr=destination.Close()}
        if ctx.Err()!=nil{return result,ctx.Err()}
        if writer.WriteError!=nil{return result,fmt.Errorf("Staging schreiben: %w",writer.WriteError)}
        if closeErr!=nil{return result,fmt.Errorf("Staging schließen: %w",closeErr)}
        if err!=nil {forgetBase(base);attempts=append(attempts,base+": Transport beim Lesen abgebrochen");continue}
        rememberBase(base)
        return result,nil
    }
    return result,fmt.Errorf("Binärtransfer fehlgeschlagen: %s",strings.Join(attempts,"; "))
}
