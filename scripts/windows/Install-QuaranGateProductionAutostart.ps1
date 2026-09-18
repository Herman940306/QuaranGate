[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Distribution,
    [Parameter(Mandatory = $true)][string]$LinuxUser,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$IdentityDigest
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'QuaranGate Owner Startup'
if ($Distribution -notmatch '^[A-Za-z0-9._-]{1,128}$') { throw 'Invalid WSL distribution identity.' }
if ($LinuxUser -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'Invalid WSL user identity.' }
if ($InstallRoot -notmatch '^/' -or $InstallRoot -match '[\x00-\x1f\x7f"]') { throw 'Invalid WSL install root.' }
if ($IdentityDigest -notmatch '^[0-9a-f]{64}$') { throw 'Invalid startup identity digest.' }
$wsl = (Get-Command 'wsl.exe' -ErrorAction Stop).Source
$startScript = "$InstallRoot/scripts/production-runtime-start.sh"
function Quote-Argument([string]$Value) {
    if ($Value -match '[\x00-\x1f\x7f"]') { throw 'Unsafe task argument.' }
    return '"' + $Value + '"'
}
$arguments = @(
    '--distribution', $Distribution,
    '--user', $LinuxUser,
    '--exec', 'bash', $startScript
) | ForEach-Object { Quote-Argument $_ }
$action = New-ScheduledTaskAction -Execute $wsl -Argument ($arguments -join ' ')
$trigger = New-ScheduledTaskTrigger -AtLogOn
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Limited
$description = "QuaranGate production startup identity=$IdentityDigest"
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Description $description -Force | Out-Null
Write-Output 'PRODUCTION_AUTOSTART_INSTALL=PASS'
