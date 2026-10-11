# Install the QueryLens CLI (Windows).
#
#   irm https://raw.githubusercontent.com/EagleMind/querylens/main/install.ps1 | iex
#
# Environment: QUERYLENS_VERSION (default: latest), QUERYLENS_INSTALL_DIR (default:
# %USERPROFILE%\.querylens\bin).
$ErrorActionPreference = 'Stop'

$repo = 'EagleMind/querylens'
$dir = if ($env:QUERYLENS_INSTALL_DIR) { $env:QUERYLENS_INSTALL_DIR } else { Join-Path $HOME '.querylens\bin' }
$asset = 'querylens-win32-x64.zip'
$url = if ($env:QUERYLENS_VERSION) {
  "https://github.com/$repo/releases/download/v$($env:QUERYLENS_VERSION.TrimStart('v'))/$asset"
} else {
  "https://github.com/$repo/releases/latest/download/$asset"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("querylens-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp $asset) -UseBasicParsing
  Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force $dir | Out-Null
  Move-Item -Force (Join-Path $tmp 'querylens.exe') (Join-Path $dir 'querylens.exe')
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$exe = Join-Path $dir 'querylens.exe'
Write-Host "Installed $(& $exe --version) to $exe"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $dir })) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
  Write-Host "Added $dir to your user PATH (open a new terminal to use it)."
}
Write-Host 'Then, in your project:  querylens capture -- npm test'
