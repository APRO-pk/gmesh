# make-dist.ps1
# Produces a clean, zip-ready copy of the GMESH project for handoff.
# Excludes build artifacts, caches, VCS, and tooling — only source is shipped.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root "dist"
$clean = Join-Path $dist "gmesh-clean"

# --- reset output ---
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $clean | Out-Null

# --- root files ---
foreach ($f in @("Cargo.toml", "Cargo.lock", "AGENTS.md", "MD-HISTORY.md", "start-gmesh.bat", "watchdog.bat")) {
    Copy-Item (Join-Path $root $f) -Destination $clean
}

# --- source directories ---
foreach ($d in @("src", "python", "web", "samples")) {
    Copy-Item (Join-Path $root $d) -Destination $clean -Recurse
}

# --- project skill referenced by AGENTS.md (kept for reproducibility) ---
if (Test-Path (Join-Path $root ".opencode\skills")) {
    Copy-Item (Join-Path $root ".opencode\skills") -Destination $clean -Recurse
}

# --- strip generated / cache artifacts from the copy ---
$excludeDirs = @("__pycache__", ".pytest_cache", ".mypy_cache", "node_modules", ".venv", "venv")
Get-ChildItem $clean -Recurse -Directory |
    Where-Object { $excludeDirs -contains $_.Name } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem $clean -Recurse -File -Filter "*.pyc" |
    Remove-Item -Force -ErrorAction SilentlyContinue

# --- zip ---
$zipName = "gmesh-source.zip"
$zip = Join-Path $dist $zipName
Compress-Archive -Path (Join-Path $clean "*") -DestinationPath $zip -Force

# --- report ---
Write-Host "Clean copy: $clean" -ForegroundColor Green
Write-Host "Zip:        $zip" -ForegroundColor Green
Write-Host ""
Write-Host "INCLUDED:" -ForegroundColor Cyan
Get-ChildItem $clean -Recurse -File | ForEach-Object { $_.FullName.Substring($clean.Length + 1) } |
    Sort-Object | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "EXCLUDED (never copied):" -ForegroundColor Yellow
Write-Host "  target\ (Rust build output)" -ForegroundColor Yellow
Write-Host "  .git\ .opencode\ dist\ (VCS / tooling / this output)" -ForegroundColor Yellow
Write-Host "  __pycache__\ *.pyc node_modules\ .venv\ venv\ (caches / env)" -ForegroundColor Yellow
