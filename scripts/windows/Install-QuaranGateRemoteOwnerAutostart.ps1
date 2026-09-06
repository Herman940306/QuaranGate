# Installs an owner-logon scheduled task that starts the already-local
# QuaranGate + projects-work stacks inside WSL. It does not store API keys,
# modify Tailscale/Funnel policy, pull images, or expose new ports.
[CmdletBinding()]
param(
    [string]$Distribution = 'Ubuntu-24.04',
    [string]$LinuxUser = 'herman',
    [string]$RepoPath = '/home/herman/projects/mcp-ide-bridge',
    [string]$TaskName = 'QuaranGate Remote Owner'
)

$ErrorActionPreference = 'Stop'

$wsl = (Get-Command wsl.exe -ErrorAction Stop).Source
$linuxCommand = "mkdir -p /home/$LinuxUser/.local/state/quarangate; cd '$RepoPath' && ./scripts/remote-owner-start.sh >> /home/$LinuxUser/.local/state/quarangate/remote-owner-autostart.log 2>&1"
$args = "-d `"$Distribution`" -u `"$LinuxUser`" -- bash -lc `"$linuxCommand`""

$action = New-ScheduledTaskAction -Execute $wsl -Argument $args
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "TASK=$TaskName"
Write-Host 'AUTOSTART=INSTALLED_AT_USER_LOGON'
Write-Host 'NOTE=Docker Desktop must be configured to start with Windows/user logon.'
