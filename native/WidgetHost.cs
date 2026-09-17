// Виджет расписания на рабочем столе — своё окно вместо окна браузера.
//
// Показывает ту же гостевую страницу /weekly.html?widget=1, но в собственном
// окне на WebView2: движок один и тот же на любом ПК (WebView2 Runtime входит
// в Windows 10/11), поэтому вид виджета везде одинаковый — в отличие от
// запуска через chrome/edge --app, где картинка зависела от того, какой
// браузер стоит у человека.
//
// Прозрачность сделана композиционным размещением: движок рисует не в дочернее
// окно, а в визуал DirectComposition, и окно получает НАСТОЯЩУЮ попиксельную
// альфу — фон сквозной или полупрозрачный, а текст и карточки остаются
// плотными. Цвет-ключ (как в браузерном виджете) здесь не работает: движок
// кладёт свою поверхность мимо поверхности окна, и ключ молча игнорируется —
// проверено, дырой становилась только та часть окна, которую рисовал не он.
// Платой за композицию идёт ручная пересылка мыши: своего окна у движка нет.
//
// Собирается штатным csc.exe из Windows: scripts/build-widget-exe.ps1.
// Адрес сервера и отпечаток сертификата вшиваются при сборке (константы ниже).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;

static class Native
{
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public const int WS_EX_TRANSPARENT = 0x00000020;
    public const int WS_EX_NOREDIRECTIONBITMAP = 0x00200000;
    public const int WS_THICKFRAME = 0x00040000;

    public const int WM_NCCALCSIZE = 0x0083;
    public const int WM_MOUSEACTIVATE = 0x0021;
    public const int WM_WINDOWPOSCHANGING = 0x0046;
    public const int WM_SYSCOMMAND = 0x0112;
    public const int WM_HOTKEY = 0x0312;
    public const int MA_NOACTIVATE = 3;
    public const int SWP_NOZORDER = 0x0004;
    public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);

    public const int WM_MOUSEMOVE = 0x0200;
    public const int WM_LBUTTONDOWN = 0x0201;
    public const int WM_LBUTTONUP = 0x0202;
    public const int WM_LBUTTONDBLCLK = 0x0203;
    public const int WM_RBUTTONDOWN = 0x0204;
    public const int WM_RBUTTONUP = 0x0205;
    public const int WM_MBUTTONDOWN = 0x0207;
    public const int WM_MBUTTONUP = 0x0208;
    public const int WM_MOUSEWHEEL = 0x020A;
    public const int WM_MOUSEHWHEEL = 0x020E;

    // Зоны окна: вернув их из WM_NCHITTEST, окно получает системное
    // перетаскивание и изменение размера — с курсорами и привязками Windows.
    public const int WM_NCHITTEST = 0x0084;
    // Окно переехало на монитор с другим масштабом: система заранее сообщает
    // новый DPI и предлагает готовый прямоугольник.
    public const int WM_DPICHANGED = 0x02E0;
    public const int SWP_NOZORDER_ACTIVATE = 0x0004 | 0x0010;
    public const int HTCLIENT = 1;
    public const int HTCAPTION = 2;
    public const int HTRIGHT = 11;
    public const int HTBOTTOM = 15;
    public const int HTBOTTOMRIGHT = 17;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int left, top, right, bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPOS
    {
        public IntPtr hwnd;
        public IntPtr hwndInsertAfter;
        public int x, y, cx, cy;
        public int flags;
    }

    // Матовое стекло: DWM размывает то, что лежит под окном, и подмешивает
    // наш цвет. Страница так не умеет — за её пикселями ничего нет, размывать
    // ей нечего.
    public const int WCA_ACCENT_POLICY = 19;
    public const int ACCENT_DISABLED = 0;
    public const int ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;

    [StructLayout(LayoutKind.Sequential)]
    public struct ACCENT_POLICY
    {
        public int AccentState;
        public int AccentFlags;
        public int GradientColor;   // 0xAABBGGRR
        public int AnimationId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINCOMPATTRDATA
    {
        public int Attribute;
        public IntPtr Data;
        public int SizeOfData;
    }

    [DllImport("user32.dll")]
    public static extern int SetWindowCompositionAttribute(IntPtr hWnd, ref WINCOMPATTRDATA data);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder cls, int max);
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SetCapture(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern bool SetDllDirectory(string path);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("dcomp.dll")]
    public static extern int DCompositionCreateDevice(IntPtr dxgiDevice, ref Guid iid, out IntPtr device);
}

// DirectComposition: нужны ровно три вызова — создать устройство, привязать его
// к окну и сделать корневой визуал, в который движок будет рисовать. Методы
// интерфейсов объявлены по порядку таблицы: те, что нам не нужны, — заглушками,
// иначе поедут смещения.
[ComImport, Guid("C37EA93A-E7AA-450D-B16F-9746CB0407F3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDCompositionDevice
{
    void Commit();
    void WaitForCommitCompletion();
    void GetFrameStatistics(IntPtr statistics);
    void CreateTargetForHwnd(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool topmost, out IDCompositionTarget target);
    void CreateVisual(out IDCompositionVisual visual);
}

[ComImport, Guid("EACDD04C-117E-4E17-88F4-D1B12B0E3D89"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDCompositionTarget
{
    void SetRoot(IDCompositionVisual visual);
}

[ComImport, Guid("4D93059D-097B-4651-9A60-F0F25116E2F3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDCompositionVisual
{
    // Методы не вызываем: визуал только отдаём движку и в корень окна.
}

// Настройки самого окна: положение, размер, сквозной режим. Всё, что относится
// к странице — вид, неделя, масштаб, фон, оформление — хранит она сама в
// localStorage своего профиля, он тоже переживает перезапуск.
// Формат «ключ=значение»: разбирается пятью строками и правится блокнотом.
static class Settings
{
    public static readonly string Dir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "schedule-widget");
    static readonly string Path_ = Path.Combine(Dir, "settings.ini");
    static readonly Dictionary<string, string> Map = new Dictionary<string, string>();

    public static void Load()
    {
        try
        {
            if (!File.Exists(Path_)) return;
            foreach (string line in File.ReadAllLines(Path_))
            {
                int i = line.IndexOf('=');
                if (i > 0) Map[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
            }
        }
        catch { /* испорченный файл настроек не должен мешать запуску */ }
    }

    public static void Save()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            List<string> lines = new List<string>();
            foreach (KeyValuePair<string, string> kv in Map) lines.Add(kv.Key + "=" + kv.Value);
            File.WriteAllLines(Path_, lines.ToArray());
        }
        catch { /* нет прав на профиль — работаем без запоминания */ }
    }

    public static string Get(string key, string def)
    {
        string v;
        return Map.TryGetValue(key, out v) && v.Length > 0 ? v : def;
    }

    public static int GetInt(string key, int def)
    {
        int v;
        return int.TryParse(Get(key, ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : def;
    }

    public static bool GetBool(string key, bool def) { return Get(key, def ? "1" : "0") == "1"; }

    public static void Set(string key, int value) { Map[key] = value.ToString(CultureInfo.InvariantCulture); }
    public static void Set(string key, bool value) { Map[key] = value ? "1" : "0"; }
}

class WidgetForm : Form
{
    // Цвет-ключ поверхности окна: под содержимым движка (визуал
    // DirectComposition) лежит обычная поверхность формы, и её пиксели этого
    // цвета Windows объявляет прозрачными — на их месте видны обои.
    static readonly Color KeyColor = Color.FromArgb(1, 2, 3);
    const int HOTKEY_GHOST = 1;
    const int HOTKEY_CLOSE = 2;

    readonly string url;
    readonly string spki;
    CoreWebView2CompositionController controller;
    // Виджет стартует вместе с Windows, и сервер к этому моменту может ещё не
    // подняться: страницу тогда просто пробуем открыть снова.
    readonly System.Windows.Forms.Timer retry = new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer drag = new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer ghostPoll = new System.Windows.Forms.Timer();
    IDCompositionDevice dcompDevice;
    IDCompositionTarget dcompTarget;
    IDCompositionVisual dcompRoot;
    bool ghost;

    public WidgetForm(string url, string spki)
    {
        this.url = url;
        this.spki = spki;
        ghost = Settings.GetBool("ghost", false);

        Text = "Расписание — виджет";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = KeyColor;
        TransparencyKey = KeyColor;
        Bounds = SavedBounds();
        drag.Interval = 15;
        drag.Tick += DragTick;
        ghostPoll.Interval = 120;
        ghostPoll.Tick += GhostTick;
    }

    // Окно не всплывает при показе и не забирает фокус: оно живёт на столе, а
    // не в очереди Alt+Tab.
    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
            // Рамку не рисуем (её съедает WM_NCCALCSIZE), но стиль нужен: без
            // него Windows отказывается менять размер по SC_SIZE.
            cp.Style |= Native.WS_THICKFRAME;
            return cp;
        }
    }

    Rectangle SavedBounds()
    {
        Rectangle wa = Screen.PrimaryScreen.WorkingArea;
        int w = Settings.GetInt("w", Math.Min(1200, wa.Width - 80));
        int h = Settings.GetInt("h", Math.Min(420, wa.Height - 160));
        int x = Settings.GetInt("x", wa.Left + 40);
        int y = Settings.GetInt("y", wa.Top + 60);
        return Clamp(new Rectangle(x, y, w, h));
    }

    // Окно шире рабочей области выглядит как «сетка не влезает»: таблица всегда
    // по ширине окна, а часть окна оказывается за краем экрана.
    static Rectangle Clamp(Rectangle r)
    {
        Rectangle wa = Screen.FromRectangle(r).WorkingArea;
        int w = Math.Max(240, Math.Min(r.Width, wa.Width));
        int h = Math.Max(120, Math.Min(r.Height, wa.Height));
        int x = Math.Min(Math.Max(r.X, wa.Left), wa.Right - w);
        int y = Math.Min(Math.Max(r.Y, wa.Top), wa.Bottom - h);
        return new Rectangle(x, y, w, h);
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        SetGhost(ghost);
        Native.RegisterHotKey(Handle, HOTKEY_GHOST, 3, 0x57);        // Ctrl+Alt+W
        Native.RegisterHotKey(Handle, HOTKEY_CLOSE, 3 | 4, 0x57);    // Ctrl+Alt+Shift+W
        try
        {
            // Окно всегда лежит под остальными, и Chromium считает его
            // закрытым: помечает вкладку скрытой и перестаёт рисовать. Эти два
            // ключа — единственное, что удерживает картинку живой.
            string extra = "--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows";
            // Сертификат сервера самоподписанный: доверяем ровно его ключу, а не
            // всем подряд — общий --ignore-certificate-errors запрещают политиками.
            if (spki.Length > 0) extra += " --ignore-certificate-errors-spki-list=" + spki;
            CoreWebView2EnvironmentOptions opts = new CoreWebView2EnvironmentOptions();
            opts.AdditionalBrowserArguments = extra;
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(
                null, Path.Combine(Settings.Dir, "profile"), opts);

            SetupComposition();
            controller = await env.CreateCoreWebView2CompositionControllerAsync(Handle);
            controller.RootVisualTarget = dcompRoot;
            controller.DefaultBackgroundColor = Color.Transparent;
            controller.Bounds = new Rectangle(Point.Empty, ClientSize);
            controller.IsVisible = true;
            ApplyRasterScale();
            controller.CursorChanged += delegate { Cursor = new Cursor(controller.Cursor); };
            dcompDevice.Commit();

            controller.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            controller.CoreWebView2.Settings.IsStatusBarEnabled = false;
            controller.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
            controller.CoreWebView2.WebMessageReceived += OnPageMessage;
            // Кнопка «✕» на странице зовёт window.close() — окно закрываем мы.
            controller.CoreWebView2.WindowCloseRequested += delegate { Close(); };
            controller.CoreWebView2.NavigationCompleted += OnNavigated;
            retry.Interval = 5000;
            retry.Tick += delegate
            {
                retry.Stop();
                if (controller != null) controller.CoreWebView2.Navigate(url);
            };
            controller.CoreWebView2.Navigate(url);
        }
        catch (Exception ex)
        {
            ShowStartupError(ex);
            Close();
        }
    }

    // Движка нет — отправлять на сайт Microsoft бессмысленно: виджет живёт в
    // локальной сети, где интернета может не быть вовсе. Установщик лежит на
    // самом сервере расписания, а рядом с виджетом — .bat, который его оттуда
    // берёт. Нет и его (программу вынули из архива) — остаётся браузерный
    // вариант, ему движок не нужен.
    void ShowStartupError(Exception ex)
    {
        string nl = Environment.NewLine;
        string dir = Path.GetDirectoryName(Application.ExecutablePath);
        string setup = Path.Combine(dir, "установить-движок.bat");
        string browser = Path.Combine(dir, "виджет (через браузер).bat");
        bool missing = ex is WebView2RuntimeNotFoundException;

        if (missing && File.Exists(setup))
        {
            DialogResult answer = MessageBox.Show(
                "Движок WebView2 на этом компьютере не установлен — без него окно-виджет не запустится." + nl + nl +
                "Рядом лежит «установить-движок.bat»: он скачает движок с сервера расписания (интернет не нужен) " +
                "и поставит его для вашего пользователя, без прав администратора." + nl + nl +
                "Запустить установку сейчас?",
                "Виджет расписания", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;
            try
            {
                ProcessStartInfo start = new ProcessStartInfo(setup);
                start.UseShellExecute = true;
                start.WorkingDirectory = dir;
                Process.Start(start);
                return;
            }
            catch (Exception startErr)
            {
                MessageBox.Show(
                    "Не удалось запустить установку движка:" + nl + nl + startErr.Message + nl + nl +
                    "Запустите «установить-движок.bat» вручную.",
                    "Виджет расписания", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
        }

        string text = missing
            ? "Движок WebView2 на этом компьютере не установлен — без него окно-виджет не запустится."
            : "Не удалось запустить движок WebView2:" + nl + nl + ex.Message;
        if (File.Exists(browser))
        {
            text += nl + nl +
                "Запасной вариант — «виджет (через браузер).bat» рядом с программой: то же окно, " +
                "но через Chrome или Edge, движок ему не нужен.";
        }
        else if (missing)
        {
            text += nl + nl + "Скачайте виджет заново со страницы расписания: в архиве есть установщик движка " +
                "и запасной браузерный вариант.";
        }
        MessageBox.Show(text, "Виджет расписания", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    // Страница не открылась (сервер ещё не поднялся или сеть не готова) —
    // повторяем каждые 5 секунд, пока не откроется. Открылась — заодно
    // сообщаем ей, стоит ли виджет в автозапуске.
    void OnNavigated(object sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            retry.Start();
            return;
        }
        retry.Stop();
    }

    // Страница спрашивает состояние сама, когда её панель готова: данные она
    // грузит асинхронно, и к концу навигации обработчиков ещё нет.
    void PushAutostart()
    {
        if (controller == null || controller.CoreWebView2 == null) return;
        controller.CoreWebView2.ExecuteScriptAsync(
            "window.widgetHostAutostart && window.widgetHostAutostart(" + (IsAutostart() ? "true" : "false") + ")");
    }

    // Автозапуск — ключ Run текущего пользователя: прав администратора не
    // нужно, ярлыков на рабочем столе не появляется, отключается тем же
    // флажком в панели виджета.
    const string RUN_KEY = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RUN_NAME = "ScheduleWidget";

    bool IsAutostart()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RUN_KEY))
            {
                return key != null && key.GetValue(RUN_NAME) != null;
            }
        }
        catch { return false; }
    }

    void SetAutostart(bool on)
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RUN_KEY))
            {
                if (key == null) return;
                if (on)
                {
                    // Адрес передаём явно: у виджета, собранного для другого
                    // сервера, вшитый адрес был бы чужим.
                    key.SetValue(RUN_NAME, "\"" + Application.ExecutablePath + "\" \"" + url + "\"");
                }
                else if (key.GetValue(RUN_NAME) != null)
                {
                    key.DeleteValue(RUN_NAME, false);
                }
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("Не удалось изменить автозапуск: " + ex.Message,
                "Виджет расписания", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    void SetupComposition()
    {
        Guid iid = typeof(IDCompositionDevice).GUID;
        IntPtr devPtr;
        int hr = Native.DCompositionCreateDevice(IntPtr.Zero, ref iid, out devPtr);
        if (hr != 0) throw new InvalidOperationException("DirectComposition недоступен (код " + hr + ")");
        dcompDevice = (IDCompositionDevice)Marshal.GetObjectForIUnknown(devPtr);
        Marshal.Release(devPtr);
        dcompDevice.CreateTargetForHwnd(Handle, true, out dcompTarget);
        dcompDevice.CreateVisual(out dcompRoot);
        dcompTarget.SetRoot(dcompRoot);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (controller != null) controller.Bounds = new Rectangle(Point.Empty, ClientSize);
    }

    // Окно переехало — движку об этом надо сказать. Он держит у себя положение
    // родительского окна и по нему пересчитывает точку мыши: без этого вызова
    // после перетаскивания клики приходят на странице СМЕЩЁННЫМИ ровно на то,
    // насколько передвинули окно, и виджет «перестаёт реагировать».
    protected override void OnMove(EventArgs e)
    {
        base.OnMove(e);
        if (controller != null) controller.NotifyParentWindowPositionChanged();
    }

    // Страница шлёт короткие команды строкой: drag:move, ghost:1, autostart:1,
    // autostart:? (спросить состояние), close. Разбирать JSON незачем.
    void OnPageMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string msg;
        try { msg = e.TryGetWebMessageAsString(); }
        catch { return; }
        if (string.IsNullOrEmpty(msg)) return;
        string[] p = msg.Split(':');
        switch (p[0])
        {
            case "drag":
                StartDrag(p.Length > 1 ? p[1] : "move");
                break;
            case "ghost":
                SetGhost(p.Length > 1 && p[1] == "1");
                Save();
                break;
            case "autostart":
                if (p.Length > 1 && p[1] == "?") PushAutostart();
                else SetAutostart(p.Length > 1 && p[1] == "1");
                break;
            // bg:#1b2430:60 — матовое стекло цвета #1b2430 плотностью 60%,
            // bg:off — стекла нет, окно сквозное.
            case "bg":
                SetGlass(p.Length > 2 ? p[1] : "", p.Length > 2 ? p[2] : "0");
                break;
            case "close":
                Close();
                break;
        }
    }

    // Перетаскивание и размер целиком системные: окно само говорит, где у него
    // «шапка» и где края, а двигает и тянет его Windows. Верхняя полоса —
    // за вычетом уголка с кнопками виджета, иначе «✕» было бы не нажать.
    IntPtr HitTest(Message m)
    {
        int lp = m.LParam.ToInt32();
        Point p = PointToClient(new Point((short)(lp & 0xFFFF), (short)((lp >> 16) & 0xFFFF)));
        float s = DpiScale;
        int edge = (int)(6 * s), cap = (int)(30 * s), btns = (int)(200 * s);
        bool right = p.X >= ClientSize.Width - edge;
        bool bottom = p.Y >= ClientSize.Height - edge;
        if (right && bottom) return (IntPtr)Native.HTBOTTOMRIGHT;
        if (right && p.Y > cap) return (IntPtr)Native.HTRIGHT;
        if (bottom) return (IntPtr)Native.HTBOTTOM;
        if (p.Y < cap && p.X < ClientSize.Width - btns) return (IntPtr)Native.HTCAPTION;
        return (IntPtr)Native.HTCLIENT;
    }

    // Перетаскивание и изменение размера ведёт само окно: пока левая кнопка
    // нажата, оно ходит за курсором. Системный цикл (SC_MOVE) здесь не годится:
    // у слоёного окна мышь ловят только непрозрачные пиксели страницы, и клик
    // приходит не в рамку окна, а в ручку на странице — она и сообщает, за что
    // взялись.
    Point grabCursor;
    Rectangle grabBounds;
    string grabEdge;

    void StartDrag(string edge)
    {
        grabEdge = edge;
        grabCursor = Cursor.Position;
        grabBounds = Bounds;
        drag.Start();
    }

    void DragTick(object sender, EventArgs e)
    {
        if ((Control.MouseButtons & MouseButtons.Left) == 0)
        {
            drag.Stop();
            Bounds = Clamp(Bounds);
            Save();
            return;
        }
        int dx = Cursor.Position.X - grabCursor.X;
        int dy = Cursor.Position.Y - grabCursor.Y;
        Bounds = grabEdge == "wh"
            ? Clamp(new Rectangle(grabBounds.X, grabBounds.Y, grabBounds.Width + dx, grabBounds.Height + dy))
            : Clamp(new Rectangle(grabBounds.X + dx, grabBounds.Y + dy, grabBounds.Width, grabBounds.Height));
    }

    // Движок рисует в наш визуал, и масштаб страницы задаём мы: он должен
    // совпадать с масштабом монитора, иначе картинка и клики разъедутся.
    // Сам движок следить за монитором не должен — окно у него не своё.
    void ApplyRasterScale()
    {
        if (controller == null) return;
        try
        {
            controller.ShouldDetectMonitorScaleChanges = false;
            controller.RasterizationScale = DpiScale;
        }
        catch { /* старый Runtime — останется масштаб по умолчанию */ }
    }

    // Масштаб монитора, на котором сейчас окно (1.0 при 100%, 1.25 при 125%).
    // Берём у системы, а не у WinForms: DeviceDpi без отдельной настройки
    // приложения остаётся системным и на втором мониторе врёт.
    float DpiScale
    {
        get
        {
            uint dpi = Native.GetDpiForWindow(Handle);
            return dpi > 0 ? dpi / 96f : 1f;
        }
    }

    // Конец перетаскивания или растягивания: не пускаем окно за край рабочей
    // области и запоминаем, где оно теперь стоит.
    protected override void OnResizeEnd(EventArgs e)
    {
        base.OnResizeEnd(e);
        Bounds = Clamp(Bounds);
        Save();
    }

    // Матовое стекло: система размывает всё, что лежит под окном, и
    // подмешивает выбранный цвет с выбранной плотностью. Размывает именно
    // система: у страницы за её пикселями ничего нет — размывать ей нечего,
    // backdrop-filter в окне с попиксельной альфой даёт пустоту.
    void SetGlass(string hex, string percent)
    {
        int rgb = 0, pct = 0;
        bool on = hex.Length == 7 && hex[0] == '#'
            && int.TryParse(hex.Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out rgb)
            && int.TryParse(percent, NumberStyles.Integer, CultureInfo.InvariantCulture, out pct)
            && pct > 0;
        Native.ACCENT_POLICY policy = new Native.ACCENT_POLICY();
        policy.AccentState = on ? Native.ACCENT_ENABLE_ACRYLICBLURBEHIND : Native.ACCENT_DISABLED;
        policy.AccentFlags = 2;
        if (on)
        {
            // DWM ждёт цвет задом наперёд: 0xAABBGGRR.
            int a = Math.Max(0, Math.Min(255, pct * 255 / 100));
            policy.GradientColor = (a << 24) | ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF);
        }
        int size = Marshal.SizeOf(typeof(Native.ACCENT_POLICY));
        IntPtr mem = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(policy, mem, false);
            Native.WINCOMPATTRDATA data = new Native.WINCOMPATTRDATA();
            data.Attribute = Native.WCA_ACCENT_POLICY;
            data.Data = mem;
            data.SizeOfData = size;
            Native.SetWindowCompositionAttribute(Handle, ref data);
        }
        finally { Marshal.FreeHGlobal(mem); }
    }

    // Сквозной режим: клики уходят рабочему столу и окнам под виджетом, а
    // уголок с кнопками остаётся живым — им режим и выключают (или Ctrl+Alt+W).
    //
    // Снимать мышь нужно НЕ с нашего окна: в композиционном размещении WebView2
    // держит поверх него собственное окно (класс Chrome_WidgetWin_1, чужой
    // процесс) и все клики достаются ему — до нас не доходит ни WM_NCHITTEST,
    // ни WM_LBUTTONDOWN (проверено логом сообщений: за клик по виджету наше
    // окно не получает ничего). Поэтому WS_EX_TRANSPARENT ставится на окно
    // движка, а уголок с кнопками освобождается по положению курсора — ровно
    // как в браузерном виджете (scripts/widget-window.ps1).
    void SetGhost(bool on)
    {
        ghost = on;
        if (on) ghostPoll.Start();
        else
        {
            ghostPoll.Stop();
            SetClickThrough(false);
        }
        if (controller != null && controller.CoreWebView2 != null)
        {
            controller.CoreWebView2.ExecuteScriptAsync(
                "window.widgetHostGhost && window.widgetHostGhost(" + (on ? "true" : "false") + ")");
        }
    }

    // Курсор над уголком с кнопками — мышь виджету возвращаем, иначе снимаем.
    // Событий мыши у нас нет (они уходят движку), поэтому курсор опрашиваем.
    void GhostTick(object sender, EventArgs e)
    {
        if (!ghost) return;
        Point c = Cursor.Position;
        Rectangle b = Bounds;
        float k = DpiScale;
        bool overBtns = c.X >= b.Right - 200 * k && c.X <= b.Right
            && c.Y >= b.Top && c.Y <= b.Top + 30 * k;
        SetClickThrough(!overBtns);
    }

    void SetClickThrough(bool on)
    {
        IntPtr h = EngineWindow();
        if (h == IntPtr.Zero) return;
        long ex = Native.GetWindowLongPtr(h, Native.GWL_EXSTYLE).ToInt64();
        long want = on ? (ex | Native.WS_EX_TRANSPARENT) : (ex & ~Native.WS_EX_TRANSPARENT);
        if (want != ex) Native.SetWindowLongPtr(h, Native.GWL_EXSTYLE, (IntPtr)want);
    }

    // Окно движка: верхнего уровня, чужой процесс, лежит точно по нашему окну.
    // По этому совпадению его и узнаём — своего идентификатора WebView2 не даёт.
    IntPtr engineWnd;

    IntPtr EngineWindow()
    {
        if (engineWnd != IntPtr.Zero && Native.IsWindow(engineWnd)) return engineWnd;
        engineWnd = IntPtr.Zero;
        if (controller == null || controller.CoreWebView2 == null) return IntPtr.Zero;
        uint browser = (uint)controller.CoreWebView2.BrowserProcessId;
        Rectangle mine = Bounds;
        Native.EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            uint pid;
            Native.GetWindowThreadProcessId(h, out pid);
            if (pid != browser) return true;
            System.Text.StringBuilder cls = new System.Text.StringBuilder(64);
            Native.GetClassName(h, cls, cls.Capacity);
            if (cls.ToString() != "Chrome_WidgetWin_1") return true;
            Native.RECT r;
            if (!Native.GetWindowRect(h, out r)) return true;
            if (r.left != mine.Left || r.top != mine.Top
                || r.right - r.left != mine.Width || r.bottom - r.top != mine.Height) return true;
            engineWnd = h;
            return false;
        }, IntPtr.Zero);
        return engineWnd;
    }

    void Save()
    {
        Settings.Set("x", Left);
        Settings.Set("y", Top);
        Settings.Set("w", Width);
        Settings.Set("h", Height);
        Settings.Set("ghost", ghost);
        Settings.Save();
    }

    // Своего окна у движка нет — мышь ему пересылаем сами. Значения
    // CoreWebView2MouseEventKind совпадают с номерами сообщений WM_*, поэтому
    // сообщение приводится к типу события как есть.
    void ForwardMouse(ref Message m)
    {
        if (controller == null) return;
        int lp = m.LParam.ToInt32();
        Point pt = new Point((short)(lp & 0xFFFF), (short)((lp >> 16) & 0xFFFF));
        uint data = 0;
        if (m.Msg == Native.WM_MOUSEWHEEL || m.Msg == Native.WM_MOUSEHWHEEL)
        {
            // У колеса координаты экранные, а поворот лежит в старшем слове.
            pt = PointToClient(pt);
            data = unchecked((uint)(int)(short)((m.WParam.ToInt64() >> 16) & 0xFFFF));
        }
        CoreWebView2MouseEventVirtualKeys keys =
            (CoreWebView2MouseEventVirtualKeys)(m.WParam.ToInt64() & 0xFFFF);
        try { controller.SendMouseInput((CoreWebView2MouseEventKind)m.Msg, keys, data, pt); }
        catch { /* движок ещё не готов — пропускаем событие */ }
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            // Рамки у окна нет: клиентская область — всё окно целиком.
            // WS_THICKFRAME при этом остаётся и даёт системное изменение размера.
            case Native.WM_NCCALCSIZE:
                if (m.WParam != IntPtr.Zero) { m.Result = IntPtr.Zero; return; }
                break;
            // Клик по виджету не выносит его наверх и не забирает фокус.
            case Native.WM_MOUSEACTIVATE:
                m.Result = (IntPtr)Native.MA_NOACTIVATE;
                return;
            // Всегда в самом низу: кто бы ни менял порядок окон, виджет
            // возвращается под остальные. Цикла-сторожа для этого не нужно.
            case Native.WM_WINDOWPOSCHANGING:
                Native.WINDOWPOS wp = (Native.WINDOWPOS)Marshal.PtrToStructure(m.LParam, typeof(Native.WINDOWPOS));
                wp.hwndInsertAfter = Native.HWND_BOTTOM;
                wp.flags &= ~Native.SWP_NOZORDER;
                Marshal.StructureToPtr(wp, m.LParam, false);
                break;
            // Переехали на монитор с другим масштабом: берём предложенный
            // системой прямоугольник и пересчитываем масштаб отрисовки движка,
            // иначе страница осталась бы нарисованной в прежнем масштабе.
            case Native.WM_DPICHANGED:
                Native.RECT sug = (Native.RECT)Marshal.PtrToStructure(m.LParam, typeof(Native.RECT));
                Native.SetWindowPos(Handle, IntPtr.Zero, sug.left, sug.top,
                    sug.right - sug.left, sug.bottom - sug.top, Native.SWP_NOZORDER_ACTIVATE);
                ApplyRasterScale();
                Save();
                m.Result = IntPtr.Zero;
                return;
            case Native.WM_HOTKEY:
                if (m.WParam.ToInt32() == HOTKEY_GHOST) { SetGhost(!ghost); Save(); }
                else if (m.WParam.ToInt32() == HOTKEY_CLOSE) Close();
                return;
            case Native.WM_NCHITTEST:
                m.Result = HitTest(m);
                return;
                break;
            case Native.WM_MOUSEMOVE:
            case Native.WM_LBUTTONUP:
            case Native.WM_LBUTTONDBLCLK:
            case Native.WM_RBUTTONDOWN:
            case Native.WM_RBUTTONUP:
            case Native.WM_MBUTTONDOWN:
            case Native.WM_MBUTTONUP:
            case Native.WM_MOUSEWHEEL:
            case Native.WM_MOUSEHWHEEL:
                ForwardMouse(ref m);
                break;
            case Native.WM_LBUTTONDOWN:
                // Захват мыши на время нажатия: без него движок теряет
                // перетаскивание (ползунок не едет за курсором). Захват берём
                // напрямую у Windows: свойство Capture у формы WinForms
                // проглатывает сообщения, и до движка не доходит даже клик.
                Native.SetCapture(Handle);
                ForwardMouse(ref m);
                break;
        }
        base.WndProc(ref m);
        if (m.Msg == Native.WM_LBUTTONUP) Native.ReleaseCapture();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        Native.UnregisterHotKey(Handle, HOTKEY_GHOST);
        Native.UnregisterHotKey(Handle, HOTKEY_CLOSE);
        Save();
        base.OnFormClosing(e);
    }
}

static class WidgetHost
{
    // Подставляются при сборке (scripts/build-widget-exe.ps1).
    const string DefaultUrl = "http://localhost:443/weekly.html?widget=1&mode=day&week=cur";
    const string SpkiHash = "";

    [STAThread]
    static void Main(string[] args)
    {
        // Сборки WebView2 лежат ресурсами внутри exe — для человека это один
        // файл. Обработчик ставим до первого обращения к их типам.
        AppDomain.CurrentDomain.AssemblyResolve += ResolveEmbedded;
        ExtractNativeLoader();
        Run(args);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    static void Run(string[] args)
    {
        string url = args.Length > 0 && args[0].StartsWith("http") ? args[0] : DefaultUrl;
        // Второй запуск не поднимает второе окно — независимо от того, какой
        // адрес внутри. Имя по профилю, а не по адресу: настройки окна и
        // профиль движка у виджетов общие, и две копии вставали ровно друг на
        // друга, отнимая мышь одна у другой.
        bool first;
        using (new Mutex(true, "schedule-widget-single", out first))
        {
            if (!first) return;
            Settings.Load();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new WidgetForm(url, SpkiHash));
        }
    }

    static Assembly ResolveEmbedded(object sender, ResolveEventArgs e)
    {
        string name = new AssemblyName(e.Name).Name + ".dll";
        using (Stream st = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (st == null) return null;
            byte[] buf = new byte[st.Length];
            int read = 0;
            while (read < buf.Length) read += st.Read(buf, read, buf.Length - read);
            return Assembly.Load(buf);
        }
    }

    // WebView2Loader.dll нативная: из ресурса её не загрузить — кладём рядом с
    // настройками и показываем каталог загрузчику DLL.
    static void ExtractNativeLoader()
    {
        try
        {
            using (Stream st = Assembly.GetExecutingAssembly().GetManifestResourceStream("WebView2Loader.dll"))
            {
                if (st == null) return;
                Directory.CreateDirectory(Settings.Dir);
                string dll = Path.Combine(Settings.Dir, "WebView2Loader.dll");
                if (!File.Exists(dll) || new FileInfo(dll).Length != st.Length)
                {
                    using (FileStream fs = File.Create(dll)) st.CopyTo(fs);
                }
                Native.SetDllDirectory(Settings.Dir);
            }
        }
        catch { /* не вышло — рядом с exe DLL всё равно может лежать */ }
    }
}
