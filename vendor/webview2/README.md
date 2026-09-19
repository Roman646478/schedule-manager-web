# WebView2 SDK — три файла из nuget

Взято из пакета `Microsoft.Web.WebView2` версии **1.0.4191.47**
(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4191.47/microsoft.web.webview2.1.0.4191.47.nupkg`
— это обычный zip):

| файл | откуда в пакете |
| --- | --- |
| `Microsoft.Web.WebView2.Core.dll` | `lib/net462/` |
| `WebView2Loader.dll` | `runtimes/win-x64/native/` |
| `x86/WebView2Loader.dll` | `runtimes/win-x86/native/` |

EXE собирается как AnyCPU. Загрузчик выбирается по разрядности процесса и
извлекается в отдельный каталог версии программы. Параметр сборки
`-Architecture x86` используется для проверки 32-битного запуска.

Обёртка `Microsoft.Web.WebView2.WinForms.dll` из пакета НЕ нужна: движок
размещается композиционно (`CreateCoreWebView2CompositionControllerAsync`),
своего дочернего окна у него нет — только визуал DirectComposition.

Лежат в репозитории намеренно: `виджет.exe` собирается штатным `csc.exe` из
Windows (`scripts/build-widget-exe.ps1`), и тянуть nuget при сборке незачем —
пакетного менеджера для .NET в проекте нет.

**Сам движок сюда не входит** — это только SDK-обвязка. Runtime предустановлен
в Windows 11, а в Windows 10 бывает и не установлен (LTSC, корпоративные
образы, машины без обновлений Edge). Для таких ПК рядом лежит
`vendor/webview2-runtime` — офлайн-установщик, который раздаёт сам сервер.

Обновлять — заменить три файла на те же из более новой версии пакета и
поправить номер здесь.
