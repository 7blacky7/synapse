#!/bin/bash
# P16-T21: Build our trusted helper via csc directly, never MSBuild. Output must be outside the source tree.
set -euo pipefail
out="$1"
sdk="$2"
source_dir="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"
compiler="$(printf '%s\n' "$sdk"/sdk/*/Roslyn/bincore/csc.dll | sort -V | tail -1)"
refs="$(printf '%s\n' "$sdk"/packs/Microsoft.NETCore.App.Ref/*/ref/net10.0 | sort -V | tail -1)"
test -f "$compiler"
test -d "$refs"
{
  printf '%s\n' '-nologo' '-target:exe' '-langversion:latest' '-nullable:enable' "-out:$out/Pruefer.dll"
  for assembly in "$refs"/*.dll; do printf '%s\n' "-r:$assembly"; done
  printf '%s\n' "-r:$(dirname "$compiler")/Microsoft.CodeAnalysis.dll" "-r:$(dirname "$compiler")/Microsoft.CodeAnalysis.CSharp.dll"
  printf '%s\n' "$source_dir/Pruefer.cs"
} > "$out/compiler.rsp"
"$sdk/dotnet" "$compiler" "@$out/compiler.rsp"
cp "$(dirname "$compiler")/Microsoft.CodeAnalysis.dll" "$(dirname "$compiler")/Microsoft.CodeAnalysis.CSharp.dll" "$out/"
runtime="$(printf '%s\n' "$sdk"/shared/Microsoft.NETCore.App/* | sort -V | tail -1)"
printf '{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"%s"}}}\n' "$(basename "$runtime")" > "$out/Pruefer.runtimeconfig.json"
rm "$out/compiler.rsp"
du -sm "$sdk" "$out" "$refs"
