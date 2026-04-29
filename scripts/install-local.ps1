$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$target = Join-Path $env:LOCALAPPDATA 'Programs\MuxMelt'
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
