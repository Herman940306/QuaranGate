# Installs an owner-logon scheduled task that starts the already-local
# QuaranGate + projects-work stacks inside WSL. It does not store API keys,
# modify Tailscale/Funnel policy, pull images, or expose new ports.
[CmdletBinding()]
param(
    [string]$Distribution = 'Ubuntu-24.04',
    [string]$LinuxUser = 'herman',
    [string]$RepoPath = '/home/herman/projects/QuaranGate',
    [string]$TaskName = 'QuaranGate Remote Owner'
)

$ErrorActionPreference = 'Stop'

$wsl = (Get-Command wsl.exe -ErrorAction Stop).Source
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source

# Keep the Task Scheduler action deliberately simple. Direct Task Scheduler ->
# wsl.exe execution returned 0xFFFFFFFF on the qualified workstation even though
# the exact same wsl.exe command succeeded interactively. Use a local Windows
# PowerShell launcher as the scheduler boundary so Windows-side startup failures
# are logged before WSL is entered; the launcher then invokes the tracked Linux
# wrapper with an argument array (no nested shell command string).
if ($Distribution -notmatch '^[A-Za-z0-9._-]+$') { throw 'Distribution contains unsupported characters.' }
if ($LinuxUser -notmatch '^[A-Za-z0-9._-]+$') { throw 'LinuxUser contains unsupported characters.' }
if ($RepoPath -notmatch '^/[A-Za-z0-9._/-]+$') { throw 'RepoPath contains unsupported characters.' }

$linuxEntrypoint = "$RepoPath/scripts/remote-owner-autostart.sh"
$launcherRoot = Join-Path $env:LOCALAPPDATA 'QuaranGate'
$launcherPath = Join-Path $launcherRoot 'RemoteOwnerAutostart.ps1'
$windowsLog = Join-Path $launcherRoot 'remote-owner-task.log'
New-Item -ItemType Directory -Force -Path $launcherRoot | Out-Null

$launcher = @"
`$ErrorActionPreference = 'Stop'
`$logPath = '$($windowsLog.Replace("'", "''"))'
function Write-TaskLog([string]`$message) {
    Add-Content -LiteralPath `$logPath -Value ((Get-Date).ToString('o') + ' ' + `$message)
}
try {
    Write-TaskLog 'REMOTE_OWNER_WINDOWS_TASK=START'
    `$args = @('-d', '$Distribution', '-u', '$LinuxUser', '--exec', '/bin/bash', '$linuxEntrypoint')
    `$proc = Start-Process -FilePath '$($wsl.Replace("'", "''"))' -ArgumentList `$args -Wait -PassThru -NoNewWindow
    Write-TaskLog ('WSL_EXIT_CODE=' + `$proc.ExitCode)
    if (`$proc.ExitCode -ne 0) { exit `$proc.ExitCode }
    Write-TaskLog 'REMOTE_OWNER_WINDOWS_TASK=PASS'
    exit 0
} catch {
    Write-TaskLog ('REMOTE_OWNER_WINDOWS_TASK=FAIL ' + `$_.Exception.Message)
    exit 1
}
"@
Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding UTF8

$actionArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcherPath`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $actionArgs -WorkingDirectory $launcherRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "TASK=$TaskName"
Write-Host 'AUTOSTART=INSTALLED_AT_USER_LOGON'
Write-Host "WINDOWS_LAUNCHER=$launcherPath"
Write-Host "WINDOWS_LOG=$windowsLog"
Write-Host 'NOTE=Docker Desktop must be configured to start with Windows/user logon.'
