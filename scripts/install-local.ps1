param(
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$defaultTarget = Join-Path $env:LOCALAPPDATA 'Programs\MuxMelt'

function Select-InstallDirectory {
  param([string]$DefaultPath)

  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Choose where to install MuxMelt'
    $dialog.ShowNewFolderButton = $true
    if (Test-Path -LiteralPath $DefaultPath) {
      $dialog.SelectedPath = $DefaultPath
    } else {
      $dialog.SelectedPath = Split-Path -Parent $DefaultPath
    }

    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
      $selected = $dialog.SelectedPath
      if ((Split-Path -Leaf $selected) -ne 'MuxMelt') {
        return (Join-Path $selected 'MuxMelt')
      }
      return $selected
    }
  } catch {
    Write-Host "Could not open folder picker: $($_.Exception.Message)"
  }

  $typedPath = Read-Host "Install directory [$DefaultPath]"
  if ([string]::IsNullOrWhiteSpace($typedPath)) {
    return $DefaultPath
  }
  return $typedPath.Trim('"')
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = Select-InstallDirectory -DefaultPath $defaultTarget
}

$target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)
$electron = Join-Path $target 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'))) {
  throw 'Electron runtime is missing. Run npm install before installing locally.'
}

Get-Process MuxMelt,electron -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Path -like "$target*" -or $_.Path -like "$repoRoot*"
  } |
  Stop-Process -Force -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}
New-Item -ItemType Directory -Path $target | Out-Null

$excludeDirs = @('.git')
robocopy $repoRoot $target /E /XD $excludeDirs | Out-Null
if ($LASTEXITCODE -ge 8) {
  throw "Copy failed with robocopy exit code $LASTEXITCODE"
}
Remove-Item -LiteralPath (Join-Path $target 'dist') -Recurse -Force -ErrorAction SilentlyContinue

Get-ChildItem -LiteralPath $target -Recurse -Force |
  Unblock-File -ErrorAction SilentlyContinue

$appPython = Join-Path $target 'python'
$pyEnv = Join-Path $env:APPDATA 'muxmelt\python-env'
if (Test-Path -LiteralPath $pyEnv) {
  Get-ChildItem -LiteralPath $pyEnv -Filter '*._pth' | ForEach-Object {
    $content = Get-Content -LiteralPath $_.FullName -Raw
    if ($content -notlike "*$appPython*") {
      Add-Content -LiteralPath $_.FullName -Value $appPython -Encoding ASCII
    }
  }
}

$shell = New-Object -ComObject WScript.Shell
$shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MuxMelt.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MuxMelt.lnk')
)

foreach ($shortcutPath in $shortcuts) {
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $electron
  $shortcut.Arguments = "`"$target`""
  $shortcut.WorkingDirectory = $target
  $shortcut.IconLocation = Join-Path $target 'build\icon.png'
  $shortcut.Save()
}

Start-Process -FilePath $electron -ArgumentList "`"$target`""
Write-Host "MuxMelt installed to $target"
