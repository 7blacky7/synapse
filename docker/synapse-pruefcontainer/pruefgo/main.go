// pruefgo (P16-T14, Pruef-Container Stufe S3): Parse-only-Pruefung mit den ORIGINAL-Parsern der Werkzeuge.
//
//	dockerfile  github.com/moby/buildkit/frontend/dockerfile/parser + instructions (wie `docker build`, ohne Bau)
//	hcl         github.com/hashicorp/hcl/v2/hclsyntax (Terraform .tf/.tfvars, Packer, Nomad, Terragrunt .hcl)
//	starlark    github.com/bazelbuild/buildtools/build (Parser von buildifier: BUILD, WORKSPACE, .bzl, .star)
//	jsonnet     github.com/google/go-jsonnet/formatter (Parser von jsonnetfmt, ohne Auswertung/Imports)
//
// Aufruf: pruefgo <sprache> [dateiname] < inhalt   -> stdout: JSON-Liste [{zeile, spalte, meldung}], Exit 0.
// pruefgo --version -> Versionen der Parser-Module (aus den Build-Infos). Nichts wird ausgefuehrt, kein Netz,
// keine Dateizugriffe ausser stdin. Der Dateiname (nur Basisname) waehlt bei Starlark den Dialekt (BUILD/.bzl).
//
// MESSUNG (P16-T14, Index-Dateien): Dockerfile 0/114 (+1 ERB-Vorlage Dockerfile.tt, wird ueber den Namen nicht
// zugeordnet), HCL 0/10, Starlark 0/4 (+0/18 weitere), Jsonnet 0 Fehlalarme auf 302 (25 Meldungen = 24 absichtlich
// kaputte error.parse-Testdateien der jsonnet-Suite + 1 echter Fehler in case_studies/micromanage).
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"

	"github.com/bazelbuild/buildtools/build"
	"github.com/google/go-jsonnet/formatter"
	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/moby/buildkit/frontend/dockerfile/instructions"
	"github.com/moby/buildkit/frontend/dockerfile/linter"
	"github.com/moby/buildkit/frontend/dockerfile/parser"
)

type meldung struct {
	Zeile   int    `json:"zeile"`
	Spalte  int    `json:"spalte,omitempty"`
	Meldung string `json:"meldung"`
}

var (
	reZeileSpalte = regexp.MustCompile(`:\(?(\d+):(\d+)`)
	// "name:Z:S: ", "name:Z:S-T ", "name:(Z:S)-(Z:S) " vorn in der Meldung
	// (go-jsonnet setzt bei Lexerfehlern die Position doppelt davor: "x:17:1-5 x:17:1-5 Unknown escape ...")
	rePosition = regexp.MustCompile(`^(?:\S*?:\(?\d+:\d+\)?(?:-\(?\d+(?::\d+)?\)?)?:?\s+)+`)
	reAufZeile    = regexp.MustCompile(`(?i)\bline (\d+)`)
)

func mindestens1(z int) int {
	if z < 1 {
		return 1
	}
	return z
}

// ortAusText: "datei:Z:S ..." (jsonnet, buildtools) bzw. "... on line Z ..." (buildkit).
func ortAusText(s string) (int, int) {
	if m := reZeileSpalte.FindStringSubmatch(s); m != nil {
		z, _ := strconv.Atoi(m[1])
		sp, _ := strconv.Atoi(m[2])
		return mindestens1(z), sp
	}
	if m := reAufZeile.FindStringSubmatch(s); m != nil {
		z, _ := strconv.Atoi(m[1])
		return mindestens1(z), 0
	}
	return 1, 0
}

// ohnePosition: Datei/Zeile/Spalte vorn entfernen (die stehen getrennt in zeile/spalte), nur die erste Zeile.
func ohnePosition(s string) string {
	s = strings.SplitN(strings.TrimSpace(s), "\n", 2)[0]
	return strings.TrimSpace(rePosition.ReplaceAllString(s, ""))
}

func dockerfile(b []byte) []meldung {
	b = bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n"))
	ort := func(err error) (int, int) {
		var loc interface{ Location() []parser.Range }
		if errors.As(err, &loc) && len(loc.Location()) > 0 {
			return mindestens1(loc.Location()[0].Start.Line), 0
		}
		return ortAusText(err.Error())
	}
	res, err := parser.Parse(bytes.NewReader(b))
	if err != nil {
		z, s := ort(err)
		return []meldung{{z, s, err.Error()}}
	}
	if _, _, err = instructions.Parse(res.AST, linter.New(&linter.Config{})); err != nil {
		z, s := ort(err)
		return []meldung{{z, s, err.Error()}}
	}
	return nil
}

func hclPruefen(b []byte, name string) []meldung {
	_, diags := hclsyntax.ParseConfig(b, name, hcl.Pos{Line: 1, Column: 1, Byte: 0})
	var aus []meldung
	for _, d := range diags {
		if d.Severity != hcl.DiagError {
			continue
		}
		m := meldung{Zeile: 1, Meldung: d.Summary}
		if d.Detail != "" {
			m.Meldung += ": " + d.Detail
		}
		if d.Subject != nil {
			m.Zeile, m.Spalte = mindestens1(d.Subject.Start.Line), d.Subject.Start.Column
		}
		aus = append(aus, m)
		if len(aus) >= 5 {
			break
		}
	}
	return aus
}

func starlark(b []byte, name string) []meldung {
	if _, err := build.ParseDefault(name, b); err != nil {
		z, s := ortAusText(err.Error())
		return []meldung{{z, s, ohnePosition(err.Error())}}
	}
	return nil
}

func jsonnet(b []byte, name string) []meldung {
	if _, err := formatter.Format(name, string(b), formatter.DefaultOptions()); err != nil {
		z, s := ortAusText(err.Error())
		return []meldung{{z, s, ohnePosition(err.Error())}}
	}
	return nil
}

func versionen() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "pruefgo ?"
	}
	teile := []string{"pruefgo " + info.GoVersion}
	for _, d := range info.Deps {
		switch d.Path {
		case "github.com/moby/buildkit", "github.com/hashicorp/hcl/v2", "github.com/bazelbuild/buildtools", "github.com/google/go-jsonnet":
			kurz := strings.TrimSuffix(d.Path, "/v2")
			teile = append(teile, kurz[strings.LastIndex(kurz, "/")+1:]+"@"+d.Version)
		}
	}
	return strings.Join(teile, " ")
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Aufruf: pruefgo dockerfile|hcl|starlark|jsonnet [dateiname] < inhalt | pruefgo --version")
		os.Exit(2)
	}
	if os.Args[1] == "--version" {
		fmt.Println(versionen())
		return
	}
	// Tiefe Verschachtelung (z. B. 10000 x '[' in der jsonnet-Testsuite) treibt die rekursiven Parser in einen Stack von
	// mehreren 100 MB - im Container-Limit (384 MB) wurde der Prozess per OOM getoetet. Mit 32 MB Stack bricht pruefgo
	// stattdessen sofort ab (Exit 2, kein Befund) und gefaehrdet die anderen Prozesse im Container nicht.
	debug.SetMaxStack(32 << 20)
	name := "eingabe"
	if len(os.Args) > 2 && os.Args[2] != "" {
		name = os.Args[2]
	}
	b, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "stdin:", err)
		os.Exit(2)
	}
	var aus []meldung
	switch os.Args[1] {
	case "dockerfile":
		aus = dockerfile(b)
	case "hcl":
		aus = hclPruefen(b, name)
	case "starlark":
		aus = starlark(b, name)
	case "jsonnet":
		aus = jsonnet(b, name)
	default:
		fmt.Fprintln(os.Stderr, "unbekannte Sprache:", os.Args[1])
		os.Exit(2)
	}
	if aus == nil {
		aus = []meldung{}
	}
	if err := json.NewEncoder(os.Stdout).Encode(aus); err != nil {
		os.Exit(2)
	}
}
