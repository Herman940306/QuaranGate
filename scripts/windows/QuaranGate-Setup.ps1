# QuaranGate guided Windows setup source.
# Release packaging must sign this file and the verified payload manifest before
# the installer is allowed to mutate product state.
[CmdletBinding()]
param(
    [string]$Distribution = 'Ubuntu-24.04',
    [string]$LinuxUser = $env:USERNAME,
    [string]$PackageRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($Distribution -notmatch '^[A-Za-z0-9._-]+$') { throw 'Distribution contains unsupported characters.' }
if ($LinuxUser -notmatch '^[A-Za-z0-9._-]+$') { throw 'Linux user contains unsupported characters.' }

$wsl = (Get-Command wsl.exe -ErrorAction Stop).Source
$linuxPackageRoot = (& $wsl -d $Distribution -u $LinuxUser --exec wslpath -a $PackageRoot 2>$null)
if ($LASTEXITCODE -ne 0 -or $linuxPackageRoot.Count -ne 1 -or $linuxPackageRoot -notmatch '^/[A-Za-z0-9._/ -]+$') {
    throw 'The package root could not be mapped to one canonical WSL path.'
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'QuaranGate Guided Setup'
$form.Size = New-Object System.Drawing.Size(720, 620)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.Font = $font

function Add-Label([string]$text, [int]$top) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $text
    $label.Location = New-Object System.Drawing.Point(24, $top)
    $label.Size = New-Object System.Drawing.Size(230, 24)
    $form.Controls.Add($label)
}

function Add-TextBox([int]$top, [string]$value) {
    $box = New-Object System.Windows.Forms.TextBox
    $box.Location = New-Object System.Drawing.Point(270, $top)
    $box.Size = New-Object System.Drawing.Size(400, 24)
    $box.Text = $value
    $form.Controls.Add($box)
    return $box
}

function Add-Combo([int]$top, [string[]]$items, [int]$selected = 0) {
    $combo = New-Object System.Windows.Forms.ComboBox
    $combo.Location = New-Object System.Drawing.Point(270, $top)
    $combo.Size = New-Object System.Drawing.Size(400, 24)
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
$projectPath = Add-TextBox 108 '/home/user/projects/project'

Add-Label 'Project authority' 148
$projectAccess = Add-Combo 148 @('READ_ONLY', 'READ_WRITE')

Add-Label 'Kiro provider' 188
$kiro = Add-Combo 188 @('DEFERRED_ENTITLEMENT', 'DISABLED', 'CONFIGURED')

Add-Label 'Copilot provider' 228
$copilot = Add-Combo 228 @('DEFERRED_ENTITLEMENT', 'DISABLED', 'CONFIGURED')

Add-Label 'Local AI profile' 268
$localAi = Add-Combo 268 @('EFFICIENT', 'BALANCED', 'CUSTOM')

Add-Label 'IDE enrollment' 308
$ide = Add-Combo 308 @('UPSTREAM_P7_PENDING')
$ide.Enabled = $false

Add-Label 'GitHub repository' 348
$githubRepository = Add-TextBox 348 ''

Add-Label 'Remote access' 388
$remote = Add-Combo 388 @('LOCAL_ONLY', 'TAILSCALE_PRIVATE')

Add-Label 'Startup' 428
$startup = Add-Combo 428 @('WINDOWS_TASK_SCHEDULER_WSL', 'DISABLED')

Add-Label 'Backup policy' 468
$backup = Add-Combo 468 @('RECOMMENDED', 'MINIMAL', 'CUSTOM')

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(24, 512)
$status.Size = New-Object System.Drawing.Size(646, 24)
$status.Text = 'PLAN_REVIEW_REQUIRED — no machine mutation has occurred.'
$form.Controls.Add($status)

$reviewButton = New-Object System.Windows.Forms.Button
$reviewButton.Text = 'Review Plan'
$reviewButton.Location = New-Object System.Drawing.Point(470, 542)
$reviewButton.Size = New-Object System.Drawing.Size(96, 30)
$form.Controls.Add($reviewButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = 'Cancel'
$cancelButton.Location = New-Object System.Drawing.Point(574, 542)
$cancelButton.Size = New-Object System.Drawing.Size(96, 30)
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.CancelButton = $cancelButton
$form.Controls.Add($cancelButton)

$reviewButton.Add_Click({
    try {
        if ($projectPath.Text -notmatch '^/[A-Za-z0-9._/ -]+$') {
            throw 'Project path must be one explicit canonical WSL path.'
        }
        $githubEnabled = -not [string]::IsNullOrWhiteSpace($githubRepository.Text)
        if ($githubEnabled -and $githubRepository.Text -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
            throw 'GitHub repository must be one selected owner/repository value.'
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
                ollama = 'CONFIGURED'
            }
            localAiProfile = $localAi.SelectedItem
            ide = 'UPSTREAM_P7_PENDING'
            githubRepository = if ($githubEnabled) { $githubRepository.Text } else { $null }
            remote = $remote.SelectedItem
            startup = $startup.SelectedItem
            backup = $backup.SelectedItem
            controlCenterUrl = 'http://127.0.0.1:8787'
        }

        $tempAnswers = Join-Path ([System.IO.Path]::GetTempPath()) ('quarangate-answers-' + [Guid]::NewGuid().ToString('N') + '.json')
        try {
            $answers | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $tempAnswers -Encoding UTF8
            $linuxAnswers = (& $wsl -d $Distribution -u $LinuxUser --exec wslpath -a $tempAnswers 2>$null)
            if ($LASTEXITCODE -ne 0 -or $linuxAnswers.Count -ne 1) { throw 'Temporary review input path conversion failed.' }

            $arguments = @(
                '-d', $Distribution,
                '-u', $LinuxUser,
                '--exec', 'node',
                "$linuxPackageRoot/dist/installer/cli.js",
                'plan',
                '--answers', $linuxAnswers
            )
            $planJson = (& $wsl @arguments 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) { throw "Readiness/plan failed: $planJson" }
            $plan = $planJson | ConvertFrom-Json -ErrorAction Stop

            $review = @"
Install root: $($plan.review.installRoot)
Project authority: $($plan.review.projectAuthority)
Providers: $($plan.review.providers)
Local AI: $($plan.review.localAi)
IDE: $($plan.review.ide)
GitHub: $($plan.review.github)
Remote: $($plan.review.remote)
Startup: $($plan.review.startup)
Backup: $($plan.review.backup)
Client permissions: $($plan.review.clientPermissions)
Plan digest: $($plan.digest)

No change will run until this exact digest and every sensitive choice are approved.
"@
            $choice = [System.Windows.Forms.MessageBox]::Show(
                $review,
                'QuaranGate — Final Review and Consent',
                [System.Windows.Forms.MessageBoxButtons]::OKCancel,
                [System.Windows.Forms.MessageBoxIcon]::Shield
            )
            if ($choice -ne [System.Windows.Forms.DialogResult]::OK) {
                $status.Text = 'NO_MUTATION — owner cancelled.'
                return
            }

            # The source candidate deliberately refuses to pretend that an unsigned,
            # unbuilt package is a release installer. The signed release wrapper
            # replaces this gate with the fixed lifecycle apply invocation.
            $status.Text = 'PACKAGE_APPLY_DEFERRED_RELEASE_GATE — reviewed plan preserved; no mutation.'
            [System.Windows.Forms.MessageBox]::Show(
                'The plan is valid, but this source candidate is not a signed release package. No installation state was changed.',
                'QuaranGate Release Gate',
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information
            ) | Out-Null
        } finally {
            if (Test-Path -LiteralPath $tempAnswers) {
                Remove-Item -LiteralPath $tempAnswers -Force
            }
        }
    } catch {
        $status.Text = 'BLOCKED — ' + $_.Exception.Message
    }
})

[void]$form.ShowDialog()
