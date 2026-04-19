# post-edit-framework-docs.ps1
# Erkennt Frameworks in Code und zeigt Hinweise auf verfuegbare Docs
# DocsBySkill: Workflow-Ergebnisse (vollstaendig anzeigen)
# DocsByTool: Context7-Ergebnisse (nur Hinweis)

param()

$inputData = $input | Out-String

try {
    $json = $inputData | ConvertFrom-Json
    $filePath = $json.tool_input.file_path
    if (-not $filePath) {
        $filePath = $json.tool_result.file_path
    }
} catch {
    exit 0
}

if ([string]::IsNullOrWhiteSpace($filePath)) {
    exit 0
}

# Alle Code-Dateien (multi-language)
$codeExtensions = @{
    '.tsx' = 'javascript'; '.ts' = 'javascript'; '.jsx' = 'javascript'; '.js' = 'javascript'
    '.vue' = 'javascript'; '.svelte' = 'javascript'
    '.go' = 'go'
    '.py' = 'python'
    '.rb' = 'ruby'
    '.rs' = 'rust'
    '.php' = 'php'
    '.css' = 'css'; '.scss' = 'css'; '.sass' = 'css'; '.less' = 'css'
    # HTML Templates
    '.html' = 'html'; '.htm' = 'html'
    '.ejs' = 'html'; '.hbs' = 'html'; '.handlebars' = 'html'
    '.tmpl' = 'html'; '.gohtml' = 'html'
    '.blade.php' = 'html'; '.twig' = 'html'
    '.pug' = 'html'; '.jade' = 'html'
}

$ext = [System.IO.Path]::GetExtension($filePath).ToLower()

if (-not $codeExtensions.ContainsKey($ext)) {
    exit 0
}

$lang = $codeExtensions[$ext]

# Datei-Inhalt lesen (erste 50 Zeilen fuer Imports)
$fileContent = ""
if (Test-Path $filePath) {
    try {
        $fileContent = Get-Content $filePath -TotalCount 50 -ErrorAction SilentlyContinue | Out-String
    } catch {
        exit 0
    }
}

if ([string]::IsNullOrWhiteSpace($fileContent)) {
    exit 0
}

# Framework-Imports extrahieren (sprachspezifisch)
$detectedFrameworks = @()

switch ($lang) {
    'javascript' {
        $jsPattern = '(?:from\s+[''"]|require\s*\([''"''])(@?[a-z0-9][\w\-./]*)'
        $regexMatches = [regex]::Matches($fileContent, $jsPattern)
        foreach ($m in $regexMatches) {
            $pkg = $m.Groups[1].Value -replace '/.*', ''
            $pkg = $pkg -replace '^@', ''
            if ($pkg -and $pkg -notin $detectedFrameworks -and $pkg.Length -gt 1) {
                $detectedFrameworks += $pkg
            }
        }
    }
    'go' {
        # Bekannte externe Go-Domains (lokale Packages ignorieren)
        $validGoDomains = @(
            'github.com', 'gitlab.com', 'bitbucket.org',
            'golang.org', 'google.golang.org', 'gopkg.in',
            'go.uber.org', 'go.etcd.io', 'k8s.io',
            'cloud.google.com', 'gorm.io', 'gocloud.dev'
        )
        $goPattern = '["`]([^"`]+)["`]'
        $blockMatches = [regex]::Matches($fileContent, $goPattern)
        foreach ($m in $blockMatches) {
            $fullPath = $m.Groups[1].Value
            # Domain-Validierung: Nur externe Packages
            $isExternal = $false
            foreach ($domain in $validGoDomains) {
                if ($fullPath.StartsWith($domain)) {
                    $isExternal = $true
                    break
                }
            }
            if (-not $isExternal) { continue }

            $pkg = $fullPath.Split('/')[-1]
            if ($pkg -and $pkg -notin $detectedFrameworks) {
                $detectedFrameworks += $pkg
            }
        }
    }
    'python' {
        $pyPattern = '(?:^|\n)\s*(?:from|import)\s+([a-z_][a-z0-9_]*)'
        $regexMatches = [regex]::Matches($fileContent, $pyPattern)
        foreach ($m in $regexMatches) {
            $pkg = $m.Groups[1].Value
            $stdlibs = @('os', 'sys', 'json', 're', 'typing', 'datetime', 'collections', 'logging', 'time', 'math', 'random', 'io', 'pathlib', 'functools', 'itertools')
            if ($pkg -and $pkg -notin $detectedFrameworks -and $pkg -notin $stdlibs) {
                $detectedFrameworks += $pkg
            }
        }
    }
    'ruby' {
        $rbPattern = 'require\s+[''"]([^''"]+)[''"]'
        $regexMatches = [regex]::Matches($fileContent, $rbPattern)
        foreach ($m in $regexMatches) {
            $pkg = $m.Groups[1].Value.Split('/')[0]
            if ($pkg -and $pkg -notin $detectedFrameworks) {
                $detectedFrameworks += $pkg
            }
        }
    }
    'rust' {
        $rsPattern = 'use\s+([a-z_][a-z0-9_]*)::'
        $regexMatches = [regex]::Matches($fileContent, $rsPattern)
        foreach ($m in $regexMatches) {
            $pkg = $m.Groups[1].Value
            if ($pkg -and $pkg -notin $detectedFrameworks -and $pkg -notin @('std', 'core', 'alloc')) {
                $detectedFrameworks += $pkg
            }
        }
    }
    'php' {
        $phpPattern = 'use\s+([A-Z][a-zA-Z0-9]*)'
        $regexMatches = [regex]::Matches($fileContent, $phpPattern)
        foreach ($m in $regexMatches) {
            $pkg = $m.Groups[1].Value.ToLower()
            if ($pkg -and $pkg -notin $detectedFrameworks) {
                $detectedFrameworks += $pkg
            }
        }
    }
    'css' {
        # Tailwind directives
        if ($fileContent -match '@tailwind') {
            $detectedFrameworks += 'tailwindcss'
        }
        # @apply with Tailwind classes
        if ($fileContent -match '@apply\s+[\w-]+') {
            if ('tailwindcss' -notin $detectedFrameworks) {
                $detectedFrameworks += 'tailwindcss'
            }
        }
        # Bootstrap imports or variables
        if ($fileContent -match 'bootstrap|--bs-') {
            $detectedFrameworks += 'bootstrap'
        }
        # Bulma
        if ($fileContent -match 'bulma|\.is-|\.has-') {
            $detectedFrameworks += 'bulma'
        }
        # Foundation
        if ($fileContent -match 'foundation') {
            $detectedFrameworks += 'foundation'
        }
        # CSS @import statements
        $importPattern = '@import\s+[''"]([^''"]+)[''"]'
        $regexMatches = [regex]::Matches($fileContent, $importPattern)
        foreach ($m in $regexMatches) {
            $importPath = $m.Groups[1].Value.ToLower()
            if ($importPath -match 'tailwind') {
                if ('tailwindcss' -notin $detectedFrameworks) { $detectedFrameworks += 'tailwindcss' }
            }
            if ($importPath -match 'bootstrap') {
                if ('bootstrap' -notin $detectedFrameworks) { $detectedFrameworks += 'bootstrap' }
            }
            if ($importPath -match 'normalize') {
                if ('normalize.css' -notin $detectedFrameworks) { $detectedFrameworks += 'normalize.css' }
            }
        }
    }
    'html' {
        # Alpine.js Detection (x-data, x-show, x-if, @click, x-model etc.)
        if ($fileContent -match 'x-data\s*=|x-show\s*=|x-if\s*=|x-model\s*=|x-bind:|x-on:|@click=|@submit=') {
            $detectedFrameworks += 'alpinejs'
        }
        # Alpine CDN
        if ($fileContent -match 'cdn\.jsdelivr\.net/npm/alpinejs|unpkg\.com/alpinejs') {
            if ('alpinejs' -notin $detectedFrameworks) { $detectedFrameworks += 'alpinejs' }
        }

        # HTMX Detection (hx-get, hx-post, hx-trigger etc.)
        if ($fileContent -match 'hx-get\s*=|hx-post\s*=|hx-put\s*=|hx-delete\s*=|hx-trigger\s*=|hx-swap\s*=|hx-target\s*=') {
            $detectedFrameworks += 'htmx'
        }
        # HTMX CDN
        if ($fileContent -match 'unpkg\.com/htmx\.org|cdn\.jsdelivr\.net/npm/htmx\.org') {
            if ('htmx' -notin $detectedFrameworks) { $detectedFrameworks += 'htmx' }
        }

        # Tailwind CSS via class detection (common utility classes)
        if ($fileContent -match 'class\s*=\s*[''"][^''"]*(?:flex|grid|p-\d|m-\d|bg-|text-|border-|rounded|shadow|w-\d|h-\d)') {
            $detectedFrameworks += 'tailwindcss'
        }
        # Tailwind CDN
        if ($fileContent -match 'cdn\.tailwindcss\.com|tailwindcss\.com/cdn') {
            if ('tailwindcss' -notin $detectedFrameworks) { $detectedFrameworks += 'tailwindcss' }
        }

        # Bootstrap Detection (Bootstrap classes)
        if ($fileContent -match 'class\s*=\s*[''"][^''"]*(?:btn\s|btn-|container|row|col-|navbar|modal|card|alert|badge)') {
            $detectedFrameworks += 'bootstrap'
        }
        # Bootstrap CDN
        if ($fileContent -match 'cdn\.jsdelivr\.net/npm/bootstrap|stackpath\.bootstrapcdn\.com|getbootstrap\.com') {
            if ('bootstrap' -notin $detectedFrameworks) { $detectedFrameworks += 'bootstrap' }
        }

        # Vue.js CDN (for non-SPA usage)
        if ($fileContent -match 'cdn\.jsdelivr\.net/npm/vue|unpkg\.com/vue|v-model\s*=|v-if\s*=|v-for\s*=|v-on:|v-bind:|\{\{\s*\w+') {
            $detectedFrameworks += 'vue'
        }

        # React CDN
        if ($fileContent -match 'unpkg\.com/react|cdn\.jsdelivr\.net/npm/react') {
            $detectedFrameworks += 'react'
        }

        # Petite-Vue (lightweight Vue alternative)
        if ($fileContent -match 'petite-vue|v-scope\s*=') {
            $detectedFrameworks += 'petite-vue'
        }

        # Stimulus (Hotwire)
        if ($fileContent -match 'data-controller\s*=|data-action\s*=|data-target\s*=|stimulus\.js') {
            $detectedFrameworks += 'stimulus'
        }

        # Turbo (Hotwire)
        if ($fileContent -match 'turbo-frame|turbo-stream|data-turbo') {
            $detectedFrameworks += 'turbo'
        }

        # jQuery
        if ($fileContent -match '\$\s*\(|\$\.ajax|jquery\.min\.js|jquery\.js|cdn\.jsdelivr\.net/npm/jquery') {
            $detectedFrameworks += 'jquery'
        }

        # Chart.js
        if ($fileContent -match 'chart\.js|cdn\.jsdelivr\.net/npm/chart\.js|new\s+Chart\s*\(') {
            $detectedFrameworks += 'chartjs'
        }

        # D3.js
        if ($fileContent -match 'd3\.min\.js|cdn\.jsdelivr\.net/npm/d3|d3\.select') {
            $detectedFrameworks += 'd3'
        }

        # Three.js
        if ($fileContent -match 'three\.min\.js|cdn\.jsdelivr\.net/npm/three|THREE\.') {
            $detectedFrameworks += 'threejs'
        }

        # Bulma CSS
        if ($fileContent -match 'cdn\.jsdelivr\.net/npm/bulma|bulma\.min\.css|class\s*=\s*[''"][^''"]*is-\w+') {
            $detectedFrameworks += 'bulma'
        }

        # Materialize CSS
        if ($fileContent -match 'materializecss|cdnjs\.cloudflare\.com/ajax/libs/materialize') {
            $detectedFrameworks += 'materialize'
        }

        # Foundation
        if ($fileContent -match 'foundation\.zurb\.com|cdn\.jsdelivr\.net/npm/foundation-sites') {
            $detectedFrameworks += 'foundation'
        }
    }
}

# Nur wenn Frameworks erkannt wurden
if ($detectedFrameworks.Count -eq 0) {
    exit 0
}

# Framework-Alias-Mapping (Package-Name -> Qdrant-Name)
$frameworkAliases = @{
    # Go
    'gin' = 'gin'; 'echo' = 'echo-go'; 'fiber' = 'fiber'
    'gorm' = 'gorm'; 'cobra' = 'cobra'; 'viper' = 'viper'
    'mux' = 'gorilla-mux'; 'websocket' = 'gorilla-websocket'; 'sessions' = 'gorilla-sessions'
    'chi' = 'chi'; 'sqlx' = 'sqlx'; 'pgx' = 'pgx'
    'zap' = 'zap'; 'logrus' = 'logrus'; 'testify' = 'testify'
    'cors' = 'gin-cors'; 'uuid' = 'go-uuid'; 'jwt' = 'jwt-go'
    'validator' = 'go-validator'; 'swag' = 'swag'
    'go-sqlite3' = 'go-sqlite3'; 'sqlite3' = 'go-sqlite3'
    'wire' = 'wire'; 'fx' = 'uber-fx'; 'excelize' = 'excelize'
    'resty' = 'go-resty'; 'ent' = 'ent'; 'bun' = 'bun-go'
    'nats.go' = 'nats-go'; 'sarama' = 'sarama'
    'grpc-go' = 'grpc-go'; 'protobuf' = 'protobuf-go'
    'gomock' = 'gomock'; 'ginkgo' = 'ginkgo'; 'gomega' = 'gomega'
    # JavaScript/Node
    'react' = 'react'; 'next' = 'next'; 'vue' = 'vue'; 'svelte' = 'svelte'
    'tailwindcss' = 'tailwind'; 'express' = 'express'; 'axios' = 'axios'
    'prisma' = 'prisma'; 'drizzle-orm' = 'drizzle'
    'zustand' = 'zustand'; 'playwright' = 'playwright'
    # Python
    'django' = 'django'; 'flask' = 'flask'; 'fastapi' = 'fastapi'
    'sqlalchemy' = 'sqlalchemy'; 'pytest' = 'pytest'
    'pandas' = 'pandas'; 'numpy' = 'numpy'
    # Rust
    'actix-web' = 'actix'; 'tokio' = 'tokio'; 'axum' = 'axum'
    'serde' = 'serde'; 'diesel' = 'diesel'
}

# Aliase anwenden
$mappedFrameworks = @()
foreach ($fw in $detectedFrameworks) {
    $fwLower = $fw.ToLower()
    if ($frameworkAliases.ContainsKey($fwLower)) {
        $mappedFrameworks += $frameworkAliases[$fwLower]
    } else {
        $mappedFrameworks += $fwLower
    }
}
$detectedFrameworks = $mappedFrameworks | Select-Object -Unique

$skillPath = "C:/Users/morit/.claude/skills/tech-docs-researcher/scripts"
$fwList = $detectedFrameworks -join ', '
$primaryFw = $detectedFrameworks[0]

# Qdrant-Konfiguration
$qdrantHost = "192.168.50.65"
$qdrantPort = 6334

# Funktion: Qdrant Collection abfragen (einfache Scroll-Abfrage)
function Get-QdrantDocs {
    param($collection, $framework)

    $body = @{
        limit = 3
        filter = @{
            must = @(
                @{ key = 'framework'; match = @{ value = $framework } }
            )
        }
        with_payload = $true
    } | ConvertTo-Json -Depth 5

    try {
        $response = Invoke-RestMethod -Uri "http://${qdrantHost}:${qdrantPort}/collections/${collection}/points/scroll" `
            -Method POST -Body $body -ContentType "application/json" -TimeoutSec 5
        return $response.result.points
    } catch {
        return @()
    }
}

# 1. DocsBySkill durchsuchen (Workflow-Ergebnisse -> vollstaendig anzeigen)
$skillResults = @(Get-QdrantDocs -collection "DocsBySkill" -framework $primaryFw)
$skillOutput = ""

if ($skillResults.Count -gt 0) {
    $skillOutput = "`n[DocsBySkill] Workflow-Ergebnisse fuer '$primaryFw':"
    foreach ($r in $skillResults) {
        $p = $r.payload
        $preview = $p.content.Substring(0, [Math]::Min(150, $p.content.Length)) -replace "`n", " "
        $skillOutput += "`n  [$($p.type)] $($p.section): $preview..."
    }
}

# 2. DocsByTool durchsuchen (Context7 -> nur Hinweis)
$toolResults = @(Get-QdrantDocs -collection "DocsByTool" -framework $primaryFw)
$toolOutput = ""

if ($toolResults.Count -gt 0) {
    $toolOutput = "`n[DocsByTool] Context7-Docs verfuegbar fuer: $primaryFw"
    $toolOutput += "`n  Abrufen: node $skillPath/context7-fallback.mjs $primaryFw <topic>"
}

# Context-Message bauen
if ($skillOutput -or $toolOutput) {
    $contextMessage = @"
=== FRAMEWORK-DOCS ===
Erkannte Frameworks: $fwList
$skillOutput
$toolOutput

Weitere Suche: node $skillPath/framework-docs-db.mjs search "<query>" $primaryFw
"@
} else {
    $contextMessage = @"
=== FRAMEWORK-DOCS ===
Erkannte Frameworks: $fwList

KEINE DOCS in Qdrant fuer '$primaryFw' gefunden!

Indexiere mit Context7:
node $skillPath/context7-fallback.mjs $primaryFw

Oder starte Workflow-Recherche (6-Schritte) fuer tiefere Analyse.
"@
}

$output = @{
    hookSpecificOutput = @{
        hookEventName = "PostToolUse"
        additionalContext = $contextMessage
    }
} | ConvertTo-Json -Depth 3 -Compress

Write-Output $output
exit 0
