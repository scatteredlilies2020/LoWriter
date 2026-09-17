param(
    [ValidateSet('start','demo','service','cli','pair','setup','build','verify','smoke','stop','quit')]
    [string]$Command = 'start',
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$Arguments
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$candidates = @()
$installed = Get-Command node.exe -ErrorAction SilentlyContinue
if ($installed) { $candidates += $installed.Source }
$candidates += Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$node = $null
foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
        $version = & $candidate --version
        if ($version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) { $node = $candidate; break }
    }
}
if (-not $node) { throw 'LoWriter requires Node 24 or newer with node:sqlite. Install a current Node LTS yourself, then run this launcher again.' }
$env:Path = (Split-Path -Parent $node) + ';' + $env:Path
function Invoke-Node([string[]]$NodeArgs) {
    & $node @NodeArgs
    if ($LASTEXITCODE -ne 0) { throw "LoWriter command failed (exit $LASTEXITCODE)." }
}
function Invoke-Npm([string[]]$NpmArgs) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { throw 'npm is needed for setup. Install it with Node, then retry.' }
    $cli = Join-Path (Split-Path -Parent $npm.Source) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $cli)) { throw 'Cannot locate npm CLI. Run npm ci manually using Node 24+.' }
    Invoke-Node (@($cli) + $NpmArgs)
}
if ($Command -eq 'setup') { Invoke-Npm @('ci','--no-audit','--no-fund'); Invoke-Node @('scripts/build.mjs'); return }
if ($Command -eq 'smoke') { Invoke-Node @('scripts/runtime-smoke.mjs'); return }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\preact'))) { throw 'First run: .\LoWriter.ps1 setup' }
if ($Command -eq 'build') { Invoke-Node @('scripts/build.mjs'); return }
if ($Command -eq 'verify') {
    Invoke-Node @('scripts/runtime-smoke.mjs')
    Invoke-Node @('node_modules/typescript/bin/tsc','--noEmit')
    Invoke-Node @('--test','--test-concurrency=1','test/*.test.ts')
    Invoke-Node @('scripts/build.mjs')
    return
}
if ($Command -eq 'demo') {
    if (-not $env:LOWRITER_DATA_DIR) { $env:LOWRITER_DATA_DIR = Join-Path $PSScriptRoot '.demo-data' }
    $demoProject = Join-Path $PSScriptRoot '.demo-project'
    New-Item -ItemType Directory -Path $demoProject -Force | Out-Null
    $greeting = Join-Path $demoProject 'greeting.js'
    if (-not (Test-Path -LiteralPath $greeting)) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'examples\demo-project\greeting.js') -Destination $greeting }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'dist\index.html'))) { Invoke-Node @('scripts/build.mjs') }
    Write-Host "Local demo project: $demoProject"
    Write-Host 'No API key or internet provider is needed. Select this folder in Coding, grant trust, then use Try the coding demo.'
    Invoke-Node @('src/launcher.ts','--demo')
    return
}
if ($Command -eq 'start') {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'dist\index.html'))) { Invoke-Node @('scripts/build.mjs') }
    Invoke-Node @('src/launcher.ts')
    return
}
if ($Command -eq 'service') { Invoke-Node @('src/main.ts'); return }
if ($Command -in @('pair','cli','stop','quit') -and -not $env:LOWRITER_DATA_DIR) {
    $normal = Join-Path $env:USERPROFILE '.lowriter\client.json'
    $demo = Join-Path $PSScriptRoot '.demo-data\client.json'
    if (-not (Test-Path -LiteralPath $normal) -and (Test-Path -LiteralPath $demo)) { $env:LOWRITER_DATA_DIR = Join-Path $PSScriptRoot '.demo-data' }
}
if ($Command -eq 'cli') { Invoke-Node (@('src/cli.ts') + $Arguments) }
else { Invoke-Node @('src/cli.ts',$Command) }
