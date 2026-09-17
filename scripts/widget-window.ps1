# Окно-виджет расписания на рабочем столе.
#
# Виджет - обычное окно браузера, а не «вклеенное в обои»: так ведёт себя и
# Desktop Calendar. Иначе по нему нельзя было бы кликать, а после скрытия на
# обоях оставались бы следы. Скрипт только доводит окно до вида виджета:
#   * стекло - фон страницы покрашен цвет-ключом и окном не показывается
#     вовсе (LWA_COLORKEY): на его месте видны обои, а карточки занятий и текст
#     остаются плотными. Затемнять фон отдельным окном-подложкой пробовали -
#     её перерисовка была видна как вспышка (замер: 6 кадров из 1490 против 0
#     без неё), поэтому подложки нет. Настоящее размытие фона
#     (SetWindowCompositionAttribute) тоже пробовали - DWM рисует размытие
#     вместо содержимого окна, страница пропадает;
#   * всегда в самом низу оконного стека - поверх ложится любое окно;
#   * нет в панели задач и в Alt+Tab, фокус не забирает;
#   * без шапки и без рамки - виджет должен выглядеть частью стола. Двигают его
#     за верхнюю кромку, размер тянут за правый и нижний край (всё это делает
#     сам сторож), закрывают кнопкой в углу самой страницы.
#
# Запускается из виджет.bat скрытым окном PowerShell и живёт, пока живо окно
# виджета: и «в самый низ», и прозрачность приходится переставлять в цикле -
# браузер поднимает окно сам и сбрасывает WS_EX_LAYERED при перерисовке.
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$ProfileDir = "$env:LOCALAPPDATA\schedule-widget",
    # Для серверной сборки: там сайт отдаётся по HTTPS с самоподписанным
    # сертификатом, и без этого браузер показал бы виджету страницу-заглушку.
    # Профиль у виджета отдельный и ходит только на свой сервер.
    [switch]$Insecure,
    # Отпечаток открытого ключа сервера (base64 SHA-256 SPKI). Точечное доверие
    # конкретному самоподписанному сертификату: работает даже там, где общий
    # «не проверять сертификаты» запрещён политиками организации.
    [string]$SpkiHash = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace WidgetWin -Name Api -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true)]
public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll", SetLastError = true)]
public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, ref uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint key, byte alpha, uint flags);
[DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr hWnd, out uint key, out byte alpha, out uint flags);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);
[DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
[DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr rgn, bool redraw);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
[DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);
"@

# Без этого Windows врёт нам координаты на мониторах с масштабом больше 100%:
# GetWindowRect отдаёт «виртуальные» пиксели (при 125% - 0.8 от настоящих), а
# SetWindowPos и SetWindowRgn ждут настоящие. Регион окна выходил на 20% меньше
# окна, и справа с низу оставалась несрезанная прозрачная полоса.
if (-not [WidgetWin.Api]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
    # PER_MONITOR_AWARE_V2 нет до Windows 10 1703 - хватит и системного.
    [void][WidgetWin.Api]::SetProcessDPIAware()
}

$GWL_EXSTYLE       = -20
$WS_EX_NOACTIVATE  = 0x08000000   # клик по виджету не делает его активным окном
$WS_EX_TOOLWINDOW  = 0x00000080   # нет в панели задач и в Alt+Tab
$WS_EX_APPWINDOW   = 0x00040000   # обратное TOOLWINDOW - снимаем
$WS_EX_LAYERED     = 0x00080000   # без него не работает цветовой ключ
$WS_EX_TRANSPARENT = 0x00000020   # сквозной режим: окно не ловит мышь
# Дальше все размеры - в пикселях страницы (CSS). На экране их надо умножать на
# масштаб монитора: Get-WidgetScale.
# Уголок с кнопками виджета остаётся «живым» даже в сквозном режиме - иначе его
# нечем было бы выключить.
$BTN_ZONE_W        = 190
$BTN_ZONE_H        = 80
$GWL_STYLE         = -16
$WS_CAPTION        = 0x00C00000   # шапка окна с названием и крестиком - убираем
$WS_SYSMENU        = 0x00080000   # системное меню - вместе с шапкой
$WS_THICKFRAME     = 0x00040000   # рамку УБИРАЕМ: её DWM рисует светлой чертой
                                  # поверх среза шапки, и над виджетом висела
                                  # прозрачная полоса. Размер меняет сам сторож.
$SWP_FRAMECHANGED  = 0x0020
$SWP_MOVE          = 0x0011       # NOSIZE | NOACTIVATE
$GRIP_PX           = 34           # верхняя кромка окна, за которую его тащат
# Правый край, за который тянут ширину. Своя полоса, а не системная рамка:
# рамка окна прозрачна и тонка, попасть в неё мышью почти нельзя.
$EDGE_PX           = 14
$MIN_W             = 320
$MIN_H             = 200
$SWP_SIZE          = 0x0012       # NOMOVE | NOACTIVATE
$SWP_NOACTIVATE    = 0x0010
# Высота шапки, которую браузер рисует ВНУТРИ окна в режиме --app. Снять её
# стилем окна нельзя (это не системный заголовок), поэтому окно обрезается
# регионом - шапка просто не показывается.
$CAPTION_PX        = 33
$VK_LBUTTON        = 0x01
$VK_CONTROL        = 0x11
$VK_MENU           = 0x12        # Alt
$VK_W              = 0x57
$WM_CLOSE          = 0x0010
# Резервное закрытие виджета - Ctrl+Alt+Shift+W. Три модификатора взяты
# намеренно: комбинация ловится глобально, в любом активном окне, и не должна
# совпасть с горячей клавишей чужой программы.
$VK_SHIFT          = 0x10
$VK_CONTROL        = 0x11
$VK_MENU           = 0x12        # Alt
$VK_W              = 0x57
$HWND_BOTTOM       = [IntPtr]1
$SWP_BOTTOM        = 0x0013       # NOSIZE | NOMOVE | NOACTIVATE
$SW_HIDE           = 0
$SW_SHOWNOACTIVATE = 4
$LWA_COLORKEY      = 0x1
# Цвет-ключ: пиксели ровно этого цвета окно не показывает вовсе. Им покрашен фон
# страницы (`body.widget` в public/css/styles.css) - сквозь него виден стол и
# наше окно-подложка. Почти чёрный, чтобы кайма сглаживания букв не бросалась в
# глаза. COLORREF - это 0x00BBGGRR, то есть #010203 записывается как 0x00030201.
$KEY_COLOR         = 0x00030201
$GW_HWNDNEXT       = 2
$script:lastBelow  = [IntPtr]::Zero   # кто лежал под виджетом в прошлом обходе

# Рабочая область монитора, на котором сейчас окно (без панели задач).
function Get-WorkArea {
    param([IntPtr]$H)
    $mi = New-Object WidgetWin.Api+MONITORINFO
    $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    $mon = [WidgetWin.Api]::MonitorFromWindow($H, 2)   # MONITOR_DEFAULTTONEAREST
    if ([WidgetWin.Api]::GetMonitorInfo($mon, [ref]$mi)) { return $mi.rcWork }
    return $null
}

# Масштаб монитора, на котором сейчас окно (125% -> 1.25).
function Get-WidgetScale {
    param([IntPtr]$H)
    $dpi = [WidgetWin.Api]::GetDpiForWindow($H)
    if ($dpi -lt 48) { return 1.0 }
    return [double]$dpi / 96.0
}

function Get-WindowTitle {
    param([IntPtr]$H)
    $sb = New-Object System.Text.StringBuilder 512
    [void][WidgetWin.Api]::GetWindowText($H, $sb, $sb.Capacity)
    return $sb.ToString()
}

function Find-Browser {
    $paths = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($p in $paths) { if (Test-Path $p) { return $p } }
    throw 'Не найден ни Chrome, ни Edge.'
}

# Окно ищем среди окон процессов браузера с НАШИМ профилем. По заголовку искать
# нельзя: слово «виджет» встречается и в заголовке редактора, открытого на этой
# же задаче, - однажды скрипт так и сделал чужому окну toolwindow.
function Find-WidgetWindow {
    $pids = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
        Where-Object { $_.CommandLine -like "*$ProfileDir*" } | Select-Object -ExpandProperty ProcessId)
    if (-not $pids.Count) { return [IntPtr]::Zero }
    $h = [WidgetWin.Api]::GetTopWindow([IntPtr]::Zero)
    while ($h -ne [IntPtr]::Zero) {
        if ([WidgetWin.Api]::IsWindowVisible($h)) {
            $wpid = [uint32]0
            [void][WidgetWin.Api]::GetWindowThreadProcessId($h, [ref]$wpid)
            if (($pids -contains [int]$wpid) -and (Get-WindowTitle $h).Length -gt 0) { return $h }
        }
        $h = [WidgetWin.Api]::GetWindow($h, 2)   # GW_HWNDNEXT
    }
    return [IntPtr]::Zero
}

# Прозрачность и отсутствие шапки браузер периодически сбрасывает сам (после
# перерисовки и смены размера), поэтому и то и другое переставляем в цикле.
$script:lastRgn = ''
function Set-WidgetLook {
    param([IntPtr]$H)
    $ex = [WidgetWin.Api]::GetWindowLong($H, $GWL_EXSTYLE)
    if (-not ($ex -band $WS_EX_LAYERED)) {
        [void][WidgetWin.Api]::SetWindowLong($H, $GWL_EXSTYLE, ($ex -bor $WS_EX_LAYERED))
    }
    # Ключ переставляем, ТОЛЬКО если он сбился. Повторный вызов с теми же
    # значениями заставляет DWM перерисовать окно целиком, и в цикле по 600 мс
    # это и читалось как «мигает вся сетка».
    $curKey = [uint32]0
    $curAlpha = [byte]0
    $curFlags = [uint32]0
    $known = [WidgetWin.Api]::GetLayeredWindowAttributes($H, [ref]$curKey, [ref]$curAlpha, [ref]$curFlags)
    if (-not $known -or $curKey -ne $KEY_COLOR -or $curFlags -ne $LWA_COLORKEY) {
        [void][WidgetWin.Api]::SetLayeredWindowAttributes($H, $KEY_COLOR, 255, $LWA_COLORKEY)
    }

    # Своя шапка браузера в режиме --app: обрезаем её регионом окна.
    $r = New-Object WidgetWin.Api+RECT
    if ([WidgetWin.Api]::GetWindowRect($H, [ref]$r)) {
        # Явное приведение: разность полей структуры приходит объектом, и
        # сравнение с числом падает («не реализует IComparable»).
        [int]$w = $r.R - $r.L
        [int]$hgt = $r.B - $r.T
        [int]$cap = [Math]::Round($CAPTION_PX * (Get-WidgetScale $H))
        # По краям окна Chrome рисует свою рамку (~8px, чистый чёрный) - страница
        # туда не достаёт, и закрасить её нечем. Срезаем регионом вместе с
        # шапкой: берём клиентскую область: всё, что вне её, - и есть рамка.
        $rc = New-Object WidgetWin.Api+RECT
        $org = New-Object WidgetWin.Api+POINT
        [int]$padL = 0
        [int]$padR = 0
        [int]$padB = 0
        if ([WidgetWin.Api]::GetClientRect($H, [ref]$rc) -and [WidgetWin.Api]::ClientToScreen($H, [ref]$org)) {
            [int]$cw = $rc.R - $rc.L
            [int]$ch = $rc.B - $rc.T
            [int]$padL = $org.X - $r.L
            [int]$padR = $r.R - ($org.X + $cw)
            [int]$padB = $r.B - ($org.Y + $ch)
            # Сверху рамка обычно нулевая, а срез шапки её и так перекрывает.
            [int]$padT = $org.Y - $r.T
            if ($padT -gt $cap) { $cap = $padT }
            if ($padL -lt 0) { $padL = 0 }
            if ($padR -lt 0) { $padR = 0 }
            if ($padB -lt 0) { $padB = 0 }
        }
        # Регион ставим только когда размер изменился: SetWindowRgn с redraw
        # перерисовывает окно целиком, а в цикле это давало заметное мерцание.
        $key = "$H|$w|$hgt|$cap|$padL|$padR|$padB"
        if ($w -gt 0 -and $hgt -gt $cap -and $key -ne $script:lastRgn) {
            $rgn = [WidgetWin.Api]::CreateRectRgn($padL, $cap, ($w - $padR), ($hgt - $padB))
            [void][WidgetWin.Api]::SetWindowRgn($H, $rgn, $true)
            $script:lastRgn = $key
        }
    }

    $st = [WidgetWin.Api]::GetWindowLong($H, $GWL_STYLE)
    if (($st -band $WS_CAPTION) -or ($st -band $WS_THICKFRAME)) {
        $st = $st -band (-bnot $WS_CAPTION) -band (-bnot $WS_SYSMENU) -band (-bnot $WS_THICKFRAME)
        [void][WidgetWin.Api]::SetWindowLong($H, $GWL_STYLE, $st)
        # Без FRAMECHANGED Windows перерисует рамку только к первому ресайзу.
        [void][WidgetWin.Api]::SetWindowPos($H, $HWND_BOTTOM, 0, 0, 0, 0, ($SWP_BOTTOM -bor $SWP_FRAMECHANGED))
    }
}

# Второй сторож не нужен: если один уже работает, просто выходим. Мьютекс, а не
# «есть ли процессы браузера»: при перезапуске браузер умирает не мгновенно, и
# по такому признаку новый сторож молча отказывался стартовать.
# Имя мьютекса привязано к профилю: на одной машине могут стоять и папка
# разработки, и серверная сборка - у каждой свой виджет и свой сторож.
$guardName = 'Local\ScheduleWidget_' + ($ProfileDir -replace '[^A-Za-z0-9]', '_')
$guard = New-Object System.Threading.Mutex($false, $guardName)
if (-not $guard.WaitOne(0)) { return }

# Окно уже открыто (перезапустили сторожа при живом виджете) - берём его как
# есть, второй браузер не поднимаем.
$hwnd = Find-WidgetWindow
if ($hwnd -eq [IntPtr]::Zero) {
    $browser = Find-Browser
    $chromeArgs = @(
        "--app=$Url",
        "--user-data-dir=$ProfileDir",
        '--no-first-run',
        '--no-default-browser-check',
        # Виджет по замыслу лежит под всеми окнами, и Chrome считает его
        # закрытым: помечает вкладку скрытой и перестаёт рисовать - окно
        # остаётся пустым стеклом. Отключаем этот расчёт.
        # HttpsUpgrades: порт 443 выглядит для браузера как HTTPS, и при
        # включённом «всегда безопасные соединения» Chrome сам переписывает
        # адрес на https://. Сервер расписания там отдаёт обычный HTTP, и
        # вместо сетки виджет показал бы жалобу на сертификат.
        '--disable-features=CalculateNativeWinOcclusion,HttpsUpgrades,HttpsFirstBalancedMode',
        '--disable-backgrounding-occluded-windows',
        # Без этого содержимое окна рисует GPU мимо слоя прозрачности, и в
        # стекле виден только чёрный фон страницы - ни сетки, ни текста.
        '--disable-direct-composition',
        '--disable-gpu',
        '--disable-gpu-compositing'
    )
    # Размер задаём только при первом запуске: дальше окно помнит своё место и
    # размер само (у него отдельный профиль браузера).
    if (-not (Test-Path $ProfileDir)) { $chromeArgs += '--window-size=1180,780' }
    if ($Insecure) { $chromeArgs += '--ignore-certificate-errors' }
    if ($SpkiHash) { $chromeArgs += "--ignore-certificate-errors-spki-list=$SpkiHash" }

    [void](Start-Process -FilePath $browser -ArgumentList $chromeArgs -PassThru)

    foreach ($i in 1..80) {
        Start-Sleep -Milliseconds 250
        $hwnd = Find-WidgetWindow
        if ($hwnd -ne [IntPtr]::Zero) { break }
    }
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'Окно виджета не появилось за 20 секунд.' }

# Панель задач подхватывает TOOLWINDOW только при следующем показе окна, поэтому
# стиль ставим на скрытом. Вынесено в функцию: окно браузер иногда пересоздаёт,
# и тогда стили приходится накладывать заново.
function Set-WidgetStyles {
    param([IntPtr]$H)
    $ex = [WidgetWin.Api]::GetWindowLong($H, $GWL_EXSTYLE)
    $ex = ($ex -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW)
    [void][WidgetWin.Api]::ShowWindow($H, $SW_HIDE)
    [void][WidgetWin.Api]::SetWindowLong($H, $GWL_EXSTYLE, $ex)
    [void][WidgetWin.Api]::ShowWindow($H, $SW_SHOWNOACTIVATE)
}

# Жив ли браузер виджета (процесс с нашим профилем).
function Test-WidgetAlive {
    return @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
        Where-Object { $_.CommandLine -like "*$ProfileDir*" }).Count -gt 0
}

# Клавиша нажата прямо сейчас. Именно GetAsyncKeyState, а не событие окна:
# виджет фокус не забирает и в сквозном режиме мышь не ловит, поэтому опрос
# идёт глобально - иначе комбинация работала бы только при активном виджете.
function Test-KeyDown {
    param([int]$Vk)
    return ([WidgetWin.Api]::GetAsyncKeyState($Vk) -band 0x8000) -ne 0
}

# Закрыть виджет: гасим браузер, запущенный с НАШИМ профилем. Обычные окна
# Chrome у них другой --user-data-dir, их это не касается. Сторож уходит следом
# сам - его цикл держится на Test-WidgetAlive.
function Stop-WidgetBrowser {
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
        Where-Object { $_.CommandLine -like "*$ProfileDir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Set-WidgetStyles $hwnd

# Сквозной режим: окно перестаёт ловить мышь, клики уходят рабочему столу и
# окнам под виджетом. Включает его кнопка на странице - она помечает заголовок
# окна меткой #ghost, которую мы здесь и читаем. Уголок с кнопками виджета при
# этом остаётся кликабельным, иначе режим нечем было бы выключить.
function Set-ClickThrough {
    param([IntPtr]$H, [bool]$On)
    $ex = [WidgetWin.Api]::GetWindowLong($H, $GWL_EXSTYLE)
    $has = ($ex -band $WS_EX_TRANSPARENT) -ne 0
    if ($has -eq $On) { return }
    $ex = if ($On) { $ex -bor $WS_EX_TRANSPARENT } else { $ex -band (-bnot $WS_EX_TRANSPARENT) }
    [void][WidgetWin.Api]::SetWindowLong($H, $GWL_EXSTYLE, $ex)
}

# Курсор над уголком с кнопками виджета?
function Test-OverButtons {
    param([IntPtr]$H)
    $r = New-Object WidgetWin.Api+RECT
    $p = New-Object WidgetWin.Api+POINT
    if (-not [WidgetWin.Api]::GetWindowRect($H, [ref]$r)) { return $false }
    if (-not [WidgetWin.Api]::GetCursorPos([ref]$p)) { return $false }
    $k = Get-WidgetScale $H
    return ($p.X -ge ($r.R - $BTN_ZONE_W * $k) -and $p.X -le $r.R -and
            $p.Y -ge $r.T -and $p.Y -le ($r.T + $BTN_ZONE_H * $k))
}

# Сторож. Шапки у окна нет, поэтому перетаскивание делаем сами: пока левая
# кнопка зажата и нажата она была в верхней кромке окна, окно едет за курсором.
$dragging = $false
$sizing = $false        # тянут правый край - ширина
$sizingV = $false       # тянут нижний край - высота
$wasDown = $false       # кнопка была зажата на прошлом обходе
$script:ghostOn = $false
$grabX = 0
$grabY = 0
$grabW = 0
$grabH = 0
$keepH = 0
$keepW = 0
$sinceLook = [Diagnostics.Stopwatch]::StartNew()
$sinceGhost = [Diagnostics.Stopwatch]::StartNew()
$rect = New-Object WidgetWin.Api+RECT
$pt = New-Object WidgetWin.Api+POINT

while ($true) {
    # Резервное закрытие. Кнопка X на странице требует мыши и живой вкладки: в
    # сквозном режиме, под чужим окном или при зависшей странице до неё не
    # добраться, а виджета нет ни в панели задач, ни в Alt+Tab.
    if ((Test-KeyDown $VK_CONTROL) -and (Test-KeyDown $VK_MENU) -and
        (Test-KeyDown $VK_SHIFT) -and (Test-KeyDown $VK_W)) {
        Stop-WidgetBrowser
        break
    }

    # Сторож переживает пересоздание окна: пока браузер с нашим профилем жив,
    # ищем окно заново и накладываем стили. Ушёл браузер - уходим и мы.
    if (-not [WidgetWin.Api]::IsWindow($hwnd)) {
        if (-not (Test-WidgetAlive)) { break }
        $again = Find-WidgetWindow
        if ($again -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500; continue }
        $hwnd = $again
        Set-WidgetStyles $hwnd
        Set-WidgetLook $hwnd
    }

    # Ctrl+Alt+W закрывает виджет: в неподвижном режиме мышью до крестика можно и
    # не добраться, если виджет накрыт окнами.
    $down = { param($k) ([WidgetWin.Api]::GetAsyncKeyState($k) -band 0x8000) -ne 0 }
    if ((& $down $VK_CONTROL) -and (& $down $VK_MENU) -and (& $down $VK_W)) {
        [void][WidgetWin.Api]::PostMessage($hwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 500
    }

    $lmbPrev = $wasDown
    $lmb = ([WidgetWin.Api]::GetAsyncKeyState($VK_LBUTTON) -band 0x8000) -ne 0
    $wasDown = $lmb
    if (-not $lmb) {
        $dragging = $false
        # Регион окна построен под старый размер и обрезал бы край до
        # следующего обхода - после ресайза накладываем его сразу.
        if ($sizing -or $sizingV) { Set-WidgetLook $hwnd }
        $sizing = $false
        $sizingV = $false
    }
    # Режим выбираем ОДИН раз, в момент нажатия. Иначе, если человек нажал на
    # кнопку в углу и повёл мышь, курсор выходил из уголка и окно вдруг начинало
    # ехать за ним.
    elseif (-not $lmbPrev -and -not $script:ghostOn) {
        if ([WidgetWin.Api]::GetCursorPos([ref]$pt) -and [WidgetWin.Api]::GetWindowRect($hwnd, [ref]$rect)) {
            $k = Get-WidgetScale $hwnd
            # Полоса перетаскивания идёт от верхней кромки и НИЖЕ среза шапки:
            # первые CAPTION_PX окна не рисуются, и если ловить только их, тащить
            # придётся за пустое место над виджетом - именно там пользователь
            # ничего и не нащупывал. Уголок с кнопками из полосы исключён.
            [int]$grip = [Math]::Round($CAPTION_PX * $k) + $GRIP_PX * $k
            if ($pt.X -ge $rect.L -and $pt.X -le $rect.R -and
                $pt.Y -ge $rect.T -and $pt.Y -lt ($rect.T + $grip) -and
                -not (Test-OverButtons $hwnd)) {
                $dragging = $true
                $grabX = $pt.X - $rect.L
                $grabY = $pt.Y - $rect.T
            }
            # Уголок с кнопками виджета не трогаем: крестик прижат к тому же
            # правому краю, и полоса ширины воровала бы клики по нему.
            elseif ($pt.X -ge ($rect.R - $EDGE_PX * $k) -and $pt.X -le $rect.R -and
                    $pt.Y -gt ($rect.T + $BTN_ZONE_H * $k) -and $pt.Y -le $rect.B) {
                $sizing = $true
                $grabW = $rect.R - $pt.X
                $keepH = $rect.B - $rect.T
            }
            # Нижняя кромка - высота. Рамки у окна нет, тянуть больше нечем.
            elseif ($pt.Y -ge ($rect.B - $EDGE_PX * $k) -and $pt.Y -le $rect.B -and
                    $pt.X -ge $rect.L -and $pt.X -le $rect.R) {
                $sizingV = $true
                $grabH = $rect.B - $pt.Y
                $keepW = $rect.R - $rect.L
            }
        }
    }

    if ($dragging -and [WidgetWin.Api]::GetCursorPos([ref]$pt)) {
        [void][WidgetWin.Api]::SetWindowPos($hwnd, $HWND_BOTTOM, ($pt.X - $grabX), ($pt.Y - $grabY), 0, 0, $SWP_MOVE)
        Start-Sleep -Milliseconds 16
        continue
    }

    # Ширина: левый край на месте, правый едет за курсором. Высоту сохраняем -
    # SetWindowPos меняет размер только целиком.
    if ($sizing -and [WidgetWin.Api]::GetCursorPos([ref]$pt) -and
        [WidgetWin.Api]::GetWindowRect($hwnd, [ref]$rect)) {
        [int]$w = $pt.X + $grabW - $rect.L
        [int]$minW = $MIN_W * (Get-WidgetScale $hwnd)
        if ($w -lt $minW) { $w = $minW }
        # Дальше края экрана не тянем: там сетка просто уезжает за монитор.
        $work = Get-WorkArea $hwnd
        if ($work -and ($rect.L + $w) -gt $work.R) { $w = $work.R - $rect.L }
        [void][WidgetWin.Api]::SetWindowPos($hwnd, $HWND_BOTTOM, 0, 0, $w, $keepH, $SWP_SIZE)
        Start-Sleep -Milliseconds 16
        continue
    }

    # Высота: верхняя кромка на месте, нижняя едет за курсором.
    if ($sizingV -and [WidgetWin.Api]::GetCursorPos([ref]$pt) -and
        [WidgetWin.Api]::GetWindowRect($hwnd, [ref]$rect)) {
        [int]$h = $pt.Y + $grabH - $rect.T
        [int]$minH = $MIN_H * (Get-WidgetScale $hwnd)
        if ($h -lt $minH) { $h = $minH }
        $work = Get-WorkArea $hwnd
        if ($work -and ($rect.T + $h) -gt $work.B) { $h = $work.B - $rect.T }
        [void][WidgetWin.Api]::SetWindowPos($hwnd, $HWND_BOTTOM, 0, 0, $keepW, $h, $SWP_SIZE)
        Start-Sleep -Milliseconds 16
        continue
    }

    # Сквозной режим проверяем часто: курсор должен «оживлять» уголок с
    # кнопками сразу, как только на него наводят.
    if ($sinceGhost.ElapsedMilliseconds -ge 120) {
        $sinceGhost.Restart()
        $title = Get-WindowTitle $hwnd
        $script:ghostOn = $title -like '*#ghost*'
        # В сквозном режиме мышь проходит виджет насквозь: клики достаются столу
        # и окнам под ним. Уголок с кнопками остаётся живым - иначе режим нечем
        # было бы выключить.
        Set-ClickThrough $hwnd ($script:ghostOn -and -not (Test-OverButtons $hwnd))
    }

    if ($sinceLook.ElapsedMilliseconds -ge 600) {
        # Вниз двигаем, только если сосед снизу сменился, то есть кто-то реально
        # пролез под виджет (или нас подняли). Безусловный SetWindowPos в каждом
        # обходе перерисовывал окно - это и было мерцание.
        $below = [WidgetWin.Api]::GetWindow($hwnd, $GW_HWNDNEXT)
        if ($below -ne $script:lastBelow) {
            [void][WidgetWin.Api]::SetWindowPos($hwnd, $HWND_BOTTOM, 0, 0, 0, 0, $SWP_BOTTOM)
            $script:lastBelow = [WidgetWin.Api]::GetWindow($hwnd, $GW_HWNDNEXT)
        }
        Set-WidgetLook $hwnd
        $sinceLook.Restart()
    }
    Start-Sleep -Milliseconds 40
}
