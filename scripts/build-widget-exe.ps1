<#
  Сборка виджета в один exe штатным компилятором Windows.

  Ставить нечего: csc.exe лежит в самой Windows (.NET Framework 4.x), а
  WebView2 Runtime предустановлен в Windows 11 (в Windows 10 бывает и нет —
  тогда его ставит установить-движок.bat из архива виджета). Три DLL SDK лежат в
  vendor/webview2 и уезжают ВНУТРЬ exe ресурсами — у человека получается один
  файл: скачал, запустил, забыл.

  Адрес сервера и отпечаток сертификата вшиваются здесь же, подстановкой
  констант в исходник: на чужом ПК ничего настраивать не нужно.

  Примеры:
    powershell -ExecutionPolicy Bypass -File scripts/build-widget-exe.ps1
    powershell -ExecutionPolicy Bypass -File scripts/build-widget-exe.ps1 `
      -Url "https://192.168.31.86:443/weekly.html?widget=1&mode=day&week=cur" `
      -SpkiHash "base64..." -Out "dist/виджет.exe"
#>
param(
  [string]$Url = '',
  [string]$SpkiHash = '',
  [string]$Out = '',
  [ValidateSet('anycpu', 'x86', 'x64')][string]$Architecture = 'anycpu'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'native\WidgetHost.cs'
$manifest = Join-Path $root 'native\app.manifest'
$vendor = Join-Path $root 'vendor\webview2'
if (-not $Out) { $Out = Join-Path $root 'dist\виджет.exe' }

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "Не найден компилятор C#: $csc (нужен .NET Framework 4.x, он входит в Windows)" }
foreach ($f in @($src, $manifest)) { if (-not (Test-Path $f)) { throw "Нет файла $f" } }

# Обёртка WinForms не нужна: движок размещается композиционно, своего
# дочернего окна у него нет — хватает Core.dll и нативного загрузчика.
$core = Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll'
$loader = Join-Path $vendor 'WebView2Loader.dll'
$loaderX86 = Join-Path $vendor 'x86\WebView2Loader.dll'
$browserScript = Join-Path $root 'scripts\widget-window.ps1'
foreach ($f in @($core, $loader, $loaderX86, $browserScript)) {
  if (-not (Test-Path $f)) { throw "Нет $f — см. vendor/webview2/README.md" }
}

# Адрес и отпечаток вшиваем подстановкой в копию исходника: /define у csc
# умеет только флаги, строку им не передать.
$code = Get-Content $src -Raw -Encoding UTF8
if ($Url) {
  if ($Url -match '"') { throw 'В адресе не должно быть кавычек' }
  $code = $code -replace '(const string DefaultUrl = ")[^"]*(")', ('${1}' + $Url + '${2}')
}
if ($SpkiHash) {
  if ($SpkiHash -match '"') { throw 'В отпечатке не должно быть кавычек' }
  $code = $code -replace '(const string SpkiHash = ")[^"]*(")', ('${1}' + $SpkiHash + '${2}')
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("widget-build-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  $tmpSrc = Join-Path $tmp 'WidgetHost.cs'
  # UTF-8 с BOM: без него csc читает кириллицу в ANSI и ломает строки.
  [IO.File]::WriteAllText($tmpSrc, $code, (New-Object Text.UTF8Encoding $true))

  $outDir = Split-Path -Parent $Out
  if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force $outDir | Out-Null }

  $cscArgs = @(
    '/nologo', '/target:winexe', "/platform:$Architecture", '/optimize+',
    "/out:$Out",
    "/win32manifest:$manifest",
    "/r:$core",
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
    # Управляемые сборки — ресурсами, их достаёт AssemblyResolve; нативный
    # загрузчик exe кладёт в профиль и показывает загрузчику DLL.
    "/resource:$core,Microsoft.Web.WebView2.Core.dll",
    "/resource:$loader,WebView2Loader.dll",
    "/resource:$loaderX86,WebView2Loader.x86.dll",
    "/resource:$browserScript,widget-window.ps1",
    $tmpSrc
  )
  $log = & $csc $cscArgs
  if ($LASTEXITCODE -ne 0) {
    $log | ForEach-Object { Write-Output $_ }
    throw "Компиляция не удалась (код $LASTEXITCODE)"
  }
  $size = [Math]::Round((Get-Item $Out).Length / 1MB, 2)
  Write-Output "Готово: $Out ($size МБ)"
  if ($Url) { Write-Output "Адрес внутри: $Url" }
}
finally {
  $resolvedBuildTemp = [IO.Path]::GetFullPath($tmp)
  $expectedBuildParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if ((Split-Path -Parent $resolvedBuildTemp).TrimEnd('\') -ne $expectedBuildParent -or (Split-Path -Leaf $resolvedBuildTemp) -notmatch '^widget-build-[a-f0-9]{32}$') { throw 'Небезопасный путь временной сборки' }
  Remove-Item -LiteralPath $resolvedBuildTemp -Recurse -Force -ErrorAction SilentlyContinue
}
