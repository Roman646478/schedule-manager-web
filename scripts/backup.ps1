#requires -Version 5
# Project backup / restore.
#   npm run backup            - create a snapshot (also run by the SessionStart hook)
#   npm run backup:list       - list snapshots
#   npm run restore           - roll back to the latest snapshot
#   npm run restore -- <name> - roll back to a specific snapshot
#
# Snapshots live NEXT TO the project (<project>-backups), not inside it, so that
# `eslint .`, `node --test` and print-rules.js never see them.
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI, so Cyrillic
# without a BOM corrupts the parse (broken quotes collapsed the switch). Keep ASCII.
# ponytail: whole-tree copy via robocopy, minus node_modules/.git.
#   Ceiling: if data/schedule.db is locked by a running server, robocopy skips/
#   fails it. Stop the server before restore. Good enough for rollback.

[CmdletBinding()]
param(
  [ValidateSet('backup', 'restore', 'list')]
  [string]$Mode = 'backup',
  [string]$Name,        # restore: which snapshot (default = latest)
  [int]$Keep = 20       # backup: how many snapshots to retain
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$store = Join-Path (Split-Path -Parent $root) ((Split-Path -Leaf $root) + '-backups')
# vendor\webview2-runtime: 200 MB offline installer, same file every time -
# no point multiplying it by 20 snapshots. Re-download if ever lost.
$excludeDirs = @('node_modules', '.git', 'vendor\webview2-runtime')

function Copy-Tree([string]$src, [string]$dst) {
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  $xd = $excludeDirs | ForEach-Object { Join-Path $src $_ }
  # /E all subdirs, /XD exclude, /R:1 /W:1 don't hang on locked files, rest = quiet.
  # robocopy: exit codes 0-7 are success, 8+ is a real error.
  $rcArgs = @($src, $dst, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH', '/NJS', '/XD') + $xd
  robocopy @rcArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed (code $LASTEXITCODE): $src -> $dst" }
  $global:LASTEXITCODE = 0
}

function Get-Snapshots {
  if (-not (Test-Path $store)) { return @() }
  Get-ChildItem $store -Directory | Sort-Object LastWriteTime -Descending
}

switch ($Mode) {
  'backup' {
    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
    $dest = Join-Path $store $stamp
    if (Test-Path $dest) { exit 0 }   # a snapshot for this second already exists
    Copy-Tree $root $dest
    Get-Snapshots | Select-Object -Skip $Keep | Remove-Item -Recurse -Force
    Write-Host "[backup] snapshot: $(Split-Path -Leaf $store)/$stamp"
  }

  'list' {
    $snaps = Get-Snapshots
    if (-not $snaps) { Write-Host 'no snapshots'; exit 0 }
    $snaps | ForEach-Object { '{0}   ({1})' -f $_.Name, $_.LastWriteTime.ToString('dd.MM HH:mm') }
  }

  'restore' {
    $snaps = Get-Snapshots
    if (-not $snaps) { throw 'no snapshots to restore' }
    $snap = if ($Name) { $snaps | Where-Object Name -eq $Name | Select-Object -First 1 }
            else { $snaps | Select-Object -First 1 }
    if (-not $snap) { throw "snapshot not found: $Name" }
    # safety net: save current state first so the restore itself can be undone
    $safety = Join-Path $store ('pre-restore_' + (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
    Copy-Tree $root $safety
    # overlay the snapshot (no mirror - leave node_modules alone)
    Copy-Tree $snap.FullName $root
    Write-Host "[restore] rolled back to $($snap.Name). Previous state saved as $(Split-Path -Leaf $safety)"
  }
}

exit 0
