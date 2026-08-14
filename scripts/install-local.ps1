param(
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$defaultTarget = Join-Path $env:LOCALAPPDATA 'Programs\MuxMelt'

function Get-NormalizedPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  return [System.IO.Path]::GetFullPath(
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  ).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Test-PathsOverlap {
  param(
    [Parameter(Mandatory = $true)][string]$First,
    [Parameter(Mandatory = $true)][string]$Second
  )

  $separator = [System.IO.Path]::DirectorySeparatorChar
  return $First.Equals($Second, [System.StringComparison]::OrdinalIgnoreCase) -or
    $First.StartsWith("$Second$separator", [System.StringComparison]::OrdinalIgnoreCase) -or
    $Second.StartsWith("$First$separator", [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePointsUnder {
  param([Parameter(Mandatory = $true)][string]$Path)

  $pending = [System.Collections.Generic.Stack[string]]::new()
  $pending.Push($Path)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $current -Force) {
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to replace a tree containing a symbolic link or junction: $($item.FullName)"
      }
      if ($item.PSIsContainer) {
        $pending.Push($item.FullName)
      }
    }
  }
}

function Assert-SafeInstallTarget {
  param([Parameter(Mandatory = $true)][string]$Path)

  $normalized = Get-NormalizedPath -Path $Path
  $root = [System.IO.Path]::GetPathRoot($normalized).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )

  if ($normalized.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to install to a drive root: $normalized"
  }
  if (-not (Split-Path -Leaf $normalized).Equals('MuxMelt', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The install directory must end in 'MuxMelt': $normalized"
  }
  if (Test-PathsOverlap -First $normalized -Second (Get-NormalizedPath -Path $repoRoot)) {
    throw 'The install directory cannot contain or be inside the source repository.'
  }
  if (Test-Path -LiteralPath $normalized) {
    $targetItem = Get-Item -LiteralPath $normalized -Force
    if (($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to replace a symbolic link or junction: $normalized"
    }
    if (-not $targetItem.PSIsContainer) {
      throw "Install target exists and is not a directory: $normalized"
    }
    Assert-NoReparsePointsUnder -Path $normalized
  }
  return $normalized
}

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

$target = Assert-SafeInstallTarget -Path $InstallDir
$electron = Join-Path $target 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'))) {
  throw 'Electron runtime is missing. Run npm ci before installing locally.'
}

$targetParent = Split-Path -Parent $target
New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
$operationId = [guid]::NewGuid().ToString('N')
$staging = Join-Path $targetParent ".MuxMelt.install-$operationId"
$backup = Join-Path $targetParent ".MuxMelt.previous-$operationId"

try {
  New-Item -ItemType Directory -Path $staging | Out-Null
  $excludeDirs = @(
    (Join-Path $repoRoot '.git'),
    (Join-Path $repoRoot 'dist'),
    (Join-Path $repoRoot 'build\bundle')
  )
  & robocopy $repoRoot $staging /E /COPY:DAT /DCOPY:DAT /XJ /R:2 /W:1 /XD $excludeDirs | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "Copy failed with robocopy exit code $LASTEXITCODE"
  }
  Assert-NoReparsePointsUnder -Path $staging

  Get-Process MuxMelt,electron -ErrorAction SilentlyContinue |
    Where-Object {
      try {
        $processPath = Get-NormalizedPath -Path $_.Path
        return $processPath.StartsWith(
          "$target$([System.IO.Path]::DirectorySeparatorChar)",
          [System.StringComparison]::OrdinalIgnoreCase
        ) -or $processPath.StartsWith(
          "$(Get-NormalizedPath -Path $repoRoot)$([System.IO.Path]::DirectorySeparatorChar)",
          [System.StringComparison]::OrdinalIgnoreCase
        )
      } catch {
        return $false
      }
    } |
    Stop-Process -Force -ErrorAction SilentlyContinue

  if (Test-Path -LiteralPath $target) {
    Move-Item -LiteralPath $target -Destination $backup
  }
  try {
    Move-Item -LiteralPath $staging -Destination $target
  } catch {
    if (Test-Path -LiteralPath $backup) {
      Move-Item -LiteralPath $backup -Destination $target
    }
    throw
  }
  if (Test-Path -LiteralPath $backup) {
    Remove-Item -LiteralPath $backup -Recurse -Force
  }
} finally {
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
}

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
