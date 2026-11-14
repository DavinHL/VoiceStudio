# Stops the VoiceStudio dev servers.
#
# Called by "VoiceStudio Stop.bat". Written in PowerShell rather than pure batch
# because the process tree (cmd -> bun -> bun -> uv -> uvicorn -> python) needs
# to be walked from the top; doing that from `for /f` inside a .bat requires so
# much quote escaping that cmd fatally mis-parses the line.
#
# Why kill from the top: uvicorn re-execs itself, so killing only the process
# that owns the socket leaves its parents behind and the port is taken again.

$ErrorActionPreference = 'SilentlyContinue'

# Names that belong to a server tree. The walk stops at anything else so a
# parent shell that merely launched the servers is never killed.
$ServerNames = @('cmd.exe', 'bun.exe', 'uv.exe', 'uvicorn.exe', 'python.exe')

function Get-RootProcess([int]$ProcessId) {
    $current = $ProcessId
    for ($i = 0; $i -lt 20; $i++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current"
        if (-not $proc) { break }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)"
        if (-not $parent) { break }
        if ($ServerNames -notcontains $parent.Name) { break }
        $current = [int]$parent.ProcessId
    }
    return $current
}

function Get-PortOwners([int[]]$Ports) {
    Get-NetTCPConnection -LocalPort $Ports -State Listen |
        Select-Object -ExpandProperty OwningProcess -Unique
}

$killed = 0

foreach ($attempt in 1..3) {
    $owners = Get-PortOwners 3900, 3901
    if (-not $owners) { break }

    $roots = $owners | ForEach-Object { Get-RootProcess $_ } | Sort-Object -Unique
    foreach ($root in $roots) {
        & taskkill.exe /PID $root /T /F 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  Stopped a server process tree (root $root)"
            $killed++
        }
    }

    Start-Sleep -Seconds 3
}

# Console windows opened by Start.bat can outlive their killed child.
foreach ($title in 'VoiceStudio Backend*', 'VoiceStudio Web UI*') {
    & taskkill.exe /FI "WINDOWTITLE eq $title" /T /F 2>&1 | Out-Null
}

Start-Sleep -Seconds 2

$left = Get-PortOwners 3900, 3901
if ($left) {
    Write-Host ""
    Write-Host "  WARNING: something is still listening on 3900 or 3901 (pid $($left -join ', '))."
    Write-Host "  Run this again, or restart the computer if it persists."
    Write-Host ""
    exit 1
}

if ($killed -eq 0) {
    Write-Host "  Nothing was running."
} else {
    Write-Host "  Stopped $killed server process tree(s)."
}
exit 0
