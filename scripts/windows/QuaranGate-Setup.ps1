# QuaranGate guided Windows production setup.
# A signed release wrapper supplies the exact release manifest, detached
# signature proof and independently managed trust policy before review.
[CmdletBinding()]
param(
    [string]$Distribution = 'Ubuntu-24.04',
    [string]$LinuxUser = $env:USERNAME,
    [string]$PackageRoot = '',
    [Parameter(Mandatory = $true)][string]$ReleaseManifest,
    [Parameter(Mandatory = $true)][string]$ReleaseSignatureProof,
    [Parameter(Mandatory = $true)][string]$ReleaseTrustPolicy
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($Distribution -notmatch '^[A-Za-z0-9._-]+$') { throw 'Distribution contains unsupported characters.' }
if ($LinuxUser -notmatch '^[A-Za-z0-9._-]+$') { throw 'Linux user contains unsupported characters.' }

function Resolve-CanonicalDirectory([string]$Value, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Label is required." }
    $item = Get-Item -LiteralPath $Value -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "$Label must be a real non-reparse directory."
    }
    return $item.FullName
}

function Resolve-CanonicalFile([string]$Value, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Label is required." }
    $item = Get-Item -LiteralPath $Value -Force -ErrorAction Stop
    if ($item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "$Label must be a real non-reparse file."
    }
    return $item.FullName
}

if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
    $PackageRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}
$PackageRoot = Resolve-CanonicalDirectory $PackageRoot 'Package root'
$ReleaseManifest = Resolve-CanonicalFile $ReleaseManifest 'Release manifest'
$ReleaseSignatureProof = Resolve-CanonicalFile $ReleaseSignatureProof 'Release signature proof'
$ReleaseTrustPolicy = Resolve-CanonicalFile $ReleaseTrustPolicy 'Release trust policy'

$wsl = (Get-Command wsl.exe -ErrorAction Stop).Source

function Convert-ToWslPath([string]$WindowsPath, [string]$Label) {
    $mapped = (& $wsl -d $Distribution -u $LinuxUser --exec wslpath -a $WindowsPath 2>$null)
    if ($LASTEXITCODE -ne 0 -or $mapped.Count -ne 1 -or $mapped -notmatch '^/[A-Za-z0-9._/ -]+$') {
        throw "$Label could not be mapped to one canonical WSL path."
    }
    return [string]$mapped
}

$linuxPackageRoot = Convert-ToWslPath $PackageRoot 'Package root'
$linuxReleaseManifest = Convert-ToWslPath $ReleaseManifest 'Release manifest'
$linuxReleaseSignatureProof = Convert-ToWslPath $ReleaseSignatureProof 'Release signature proof'
$linuxReleaseTrustPolicy = Convert-ToWslPath $ReleaseTrustPolicy 'Release trust policy'

$form = New-Object System.Windows.Forms.Form
$form.Text = 'QuaranGate Guided Setup'
$form.Size = New-Object System.Drawing.Size(760, 660)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.Font = $font

function Add-Label([string]$text, [int]$top) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $text
    $label.Location = New-Object System.Drawing.Point(24, $top)
    $label.Size = New-Object System.Drawing.Size(260, 24)
    $form.Controls.Add($label)
}

function Add-TextBox([int]$top, [string]$value) {
    $box = New-Object System.Windows.Forms.TextBox
    $box.Location = New-Object System.Drawing.Point(290, $top)
    $box.Size = New-Object System.Drawing.Size(420, 24)
    $box.Text = $value
    $form.Controls.Add($box)
    return $box
}

function Add-Combo([int]$top, [string[]]$items, [int]$selected = 0) {
    $combo = New-Object System.Windows.Forms.ComboBox
    $combo.Location = New-Object System.Drawing.Point(290, $top)
    $combo.Size = New-Object System.Drawing.Size(420, 24)
    $combo.DropDownStyle = 'DropDownList'
    [void]$combo.Items.AddRange($items)
    $combo.SelectedIndex = $selected
    $form.Controls.Add($combo)
    return $combo
}

Add-Label 'Starting profile' 28
$profile = Add-Combo 28 @('RECOMMENDED', 'DEVELOPER', 'QA_TESTING', 'ADVANCED_CUSTOM')

Add-Label 'WSL install root' 68
$installRoot = Add-TextBox 68 "/home/$LinuxUser/.local/share/quarangate/app"

Add-Label 'Project path (WSL)' 108
$projectPath = Add-TextBox 108 "/home/$LinuxUser/projects/project"

Add-Label 'Project authority' 148
$projectAccess = Add-Combo 148 @('READ_ONLY', 'READ_WRITE')

Add-Label 'Kiro activation' 188
$kiro = Add-Combo 188 @('DEFERRED_ENTITLEMENT', 'DISABLED')

Add-Label 'Copilot activation' 228
$copilot = Add-Combo 228 @('DEFERRED_ENTITLEMENT', 'DISABLED')

Add-Label 'Local AI profile (post-install)' 268
$localAi = Add-Combo 268 @('EFFICIENT', 'BALANCED')

Add-Label 'IDE enrollment' 308
$ide = Add-Combo 308 @('POST_INSTALL_QUALIFICATION')
$ide.Enabled = $false

Add-Label 'GitHub enrollment' 348
$github = Add-Combo 348 @('POST_INSTALL_QUALIFICATION')
$github.Enabled = $false

Add-Label 'Remote access' 388
$remote = Add-Combo 388 @('LOCAL_ONLY')
$remote.Enabled = $false

Add-Label 'Startup' 428
$startup = Add-Combo 428 @('WINDOWS_TASK_SCHEDULER_WSL', 'DISABLED')

Add-Label 'Backup policy' 468
$backup = Add-Combo 468 @('RECOMMENDED', 'MINIMAL', 'CUSTOM')

$boundary = New-Object System.Windows.Forms.Label
$boundary.Location = New-Object System.Drawing.Point(24, 505)
$boundary.Size = New-Object System.Drawing.Size(686, 40)
$boundary.Text = 'Provider, GitHub, IDE and remote activation occur only after the trusted fresh install and their own qualification gates.'
$form.Controls.Add($boundary)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(24, 550)
$status.Size = New-Object System.Drawing.Size(686, 24)
$status.Text = 'SIGNED_RELEASE_REVIEW_REQUIRED — no machine mutation has occurred.'
$form.Controls.Add($status)

$reviewButton = New-Object System.Windows.Forms.Button
$reviewButton.Text = 'Review & Install'
$reviewButton.Location = New-Object System.Drawing.Point(482, 580)
$reviewButton.Size = New-Object System.Drawing.Size(124, 30)
$form.Controls.Add($reviewButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = 'Cancel'
$cancelButton.Location = New-Object System.Drawing.Point(614, 580)
$cancelButton.Size = New-Object System.Drawing.Size(96, 30)
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.CancelButton = $cancelButton
$form.Controls.Add($cancelButton)

$reviewButton.Add_Click({
    $tempAnswers = $null
    $tempConsent = $null
    try {
        if ($installRoot.Text -notmatch '^/[A-Za-z0-9._/ -]+$') {
            throw 'Install root must be one explicit canonical WSL path.'
        }
        if ($projectPath.Text -notmatch '^/[A-Za-z0-9._/ -]+$') {
            throw 'Project path must be one explicit canonical WSL path.'
        }

        $answers = [ordered]@{
            schemaVersion = 1
            profile = $profile.SelectedItem
            installRoot = $installRoot.Text
            project = [ordered]@{
                id = 'owner-project'
                path = $projectPath.Text
                access = $projectAccess.SelectedItem
            }
            providers = [ordered]@{
                kiro = $kiro.SelectedItem
                copilot = $copilot.SelectedItem
                ollama = 'DISABLED'
            }
            localAiProfile = $localAi.SelectedItem
            ide = 'UPSTREAM_P7_PENDING'
            githubRepository = $null
            remote = 'LOCAL_ONLY'
            startup = $startup.SelectedItem
            backup = $backup.SelectedItem
            controlCenterUrl = 'http://127.0.0.1:8787'
        }

        $tempAnswers = Join-Path ([System.IO.Path]::GetTempPath()) ('quarangate-answers-' + [Guid]::NewGuid().ToString('N') + '.json')
        $answers | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $tempAnswers -Encoding UTF8
        $linuxAnswers = Convert-ToWslPath $tempAnswers 'Temporary review input'

        $releaseArguments = @(
            '--answers', $linuxAnswers,
            '--package-root', $linuxPackageRoot,
            '--manifest', $linuxReleaseManifest,
            '--signature-proof', $linuxReleaseSignatureProof,
            '--trust-policy', $linuxReleaseTrustPolicy
        )
        $planArguments = @(
            '-d', $Distribution,
            '-u', $LinuxUser,
            '--exec', 'node',
            "$linuxPackageRoot/dist/installer/cli.js",
            'plan-production'
        ) + $releaseArguments

        $planJson = (& $wsl @planArguments 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Signed release/readiness plan failed: $planJson" }
        $plan = $planJson | ConvertFrom-Json -ErrorAction Stop

        $consents = if ($plan.requiredConsents.Count -gt 0) {
            ($plan.requiredConsents -join [Environment]::NewLine)
        } else {
            '(none)'
        }
        $review = @"
Release: $($plan.review.release)
Host: $($plan.review.host.platform) / WSL $($plan.review.host.wslVersion) / $($plan.review.host.wslDistribution)
Runtime user: $($plan.review.host.runtimeUser.name) uid=$($plan.review.host.runtimeUser.uid) gid=$($plan.review.host.runtimeUser.gid)
Install root: $($plan.review.installRoot)
Project authority: $($plan.review.projectAuthority)
Providers: $($plan.review.providers)
Local AI: $($plan.review.localAi)
IDE: post-install qualification
GitHub: post-install qualification
Remote: LOCAL_ONLY
Startup: $($plan.review.startup)
Backup: $($plan.review.backup)
Client permissions: $($plan.review.clientPermissions)

Required explicit consents:
$consents

Plan digest: $($plan.digest)

Only this exact verified release, host identity, answers, digest and consent set may be applied.
"@
        $choice = [System.Windows.Forms.MessageBox]::Show(
            $review,
            'QuaranGate — Final Signed Release Review and Consent',
            [System.Windows.Forms.MessageBoxButtons]::OKCancel,
            [System.Windows.Forms.MessageBoxIcon]::Shield
        )
        if ($choice -ne [System.Windows.Forms.DialogResult]::OK) {
            $status.Text = 'NO_MUTATION — owner cancelled.'
            return
        }

        $operationId = 'install-' + [Guid]::NewGuid().ToString('N')
        $installationId = [Guid]::NewGuid().ToString()
        $consent = [ordered]@{
            schemaVersion = 1
            accepted = $true
            expectedPlanDigest = [string]$plan.digest
            approvedSensitiveChoices = @($plan.requiredConsents)
            operationId = $operationId
            installationId = $installationId
        }
        $tempConsent = Join-Path ([System.IO.Path]::GetTempPath()) ('quarangate-consent-' + [Guid]::NewGuid().ToString('N') + '.json')
        $consent | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $tempConsent -Encoding UTF8
        $linuxConsent = Convert-ToWslPath $tempConsent 'Temporary consent input'

        $applyArguments = @(
            '-d', $Distribution,
            '-u', $LinuxUser,
            '--exec', 'node',
            "$linuxPackageRoot/dist/installer/cli.js",
            'apply-production'
        ) + $releaseArguments + @('--consent', $linuxConsent)

        $status.Text = 'APPLYING_VERIFIED_RELEASE — lifecycle checks are running.'
        $applyJson = (& $wsl @applyArguments 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Production install blocked: $applyJson" }
        $result = $applyJson | ConvertFrom-Json -ErrorAction Stop
        if ($result.status -ne 'PASS' -or $result.lifecycleState -ne 'SUCCESS' -or -not $result.controlCenterOpened) {
            throw 'Production installer did not return a complete PASS result.'
        }
        if ($null -eq $result.ownerCredential -or [string]::IsNullOrWhiteSpace([string]$result.ownerCredential.apiKey)) {
            throw 'Production installer did not return the one-time owner credential.'
        }

        $status.Text = 'INSTALL_COMPLETE — Control Center health accepted.'
        $credentialMessage = @"
QuaranGate installation completed.

One-time owner Control Center credential:
$($result.ownerCredential.apiKey)

Store this credential securely now. The setup wizard does not persist the plaintext credential.
"@
        [System.Windows.Forms.MessageBox]::Show(
            $credentialMessage,
            'QuaranGate — Installation Complete',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
    } catch {
        $status.Text = 'BLOCKED — ' + $_.Exception.Message
    } finally {
        foreach ($temporary in @($tempConsent, $tempAnswers)) {
            if ($null -ne $temporary -and (Test-Path -LiteralPath $temporary)) {
                Remove-Item -LiteralPath $temporary -Force
            }
        }
    }
})

[void]$form.ShowDialog()
