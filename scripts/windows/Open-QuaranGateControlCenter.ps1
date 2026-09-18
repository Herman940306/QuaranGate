[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Url)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Url -ne 'http://127.0.0.1:8787') { throw 'Only the fixed loopback Control Center URL is permitted.' }
Start-Process $Url
Write-Output 'CONTROL_CENTER_OPEN=PASS'
