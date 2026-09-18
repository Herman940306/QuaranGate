[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'QuaranGate Owner Startup'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    [pscustomobject]@{ exists = $false } | ConvertTo-Json -Compress
    exit 0
}
$actions = @($task.Actions)
$triggers = @($task.Triggers)
if ($actions.Count -ne 1) { throw 'QuaranGate startup task must have exactly one action.' }
if ($triggers.Count -ne 1) { throw 'QuaranGate startup task must have exactly one trigger.' }
[pscustomobject]@{
    exists = $true
    description = [string]$task.Description
    execute = [string]$actions[0].Execute
    arguments = [string]$actions[0].Arguments
    principalUserId = [string]$task.Principal.UserId
    principalLogonType = [string]$task.Principal.LogonType
    principalRunLevel = [string]$task.Principal.RunLevel
    triggerType = [string]$triggers[0].CimClass.CimClassName
    triggerUserId = [string]$triggers[0].UserId
} | ConvertTo-Json -Compress
