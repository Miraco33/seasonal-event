[CmdletBinding()]
param(
    [ValidateSet("Compile", "Release")]
    [string]$Mode = "Compile",

    [switch]$NoRestore
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$workspaceDotnet = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) ".dotnet\dotnet.exe"
$localDotnet = Join-Path $PSScriptRoot ".dotnet\dotnet.exe"
$dotnet = if (Test-Path -LiteralPath $localDotnet -PathType Leaf) {
    $localDotnet
} elseif (Test-Path -LiteralPath $workspaceDotnet -PathType Leaf) {
    $workspaceDotnet
} else {
    (Get-Command dotnet -ErrorAction Stop).Source
}

$arguments = @("build", (Join-Path $PSScriptRoot "SeasonalEvent.csproj"), "-c", "Release")
if ($Mode -eq "Compile") {
    $arguments += "-t:Compile"
}
if ($NoRestore) {
    $arguments += "--no-restore"
}

& $dotnet @arguments
exit $LASTEXITCODE
