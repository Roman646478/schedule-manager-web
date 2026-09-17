// Печать «в один лист»: перед печатью подбираем три величины, которыми
// css/print.css вписывает содержимое в одну вертикальную страницу A4:
//   --print-zoom       общий масштаб (нужен, только если даже мелкий шрифт не влез);
//   --print-grid-font  размер текста в ячейках — максимальный, при котором
//                      содержимое ещё помещается по высоте;
//   --print-row-h      высота строки сетки — остаток высоты листа.
//
// Почему подбор, а не чистый CSS: правила «вписать содержимое в страницу» в CSS
// нет. Мерить надо в ПЕЧАТНОЙ раскладке, а к моменту beforeprint браузер её ещё
// не применил — поэтому на время замера включаем ту же таблицу стилей на экране
// (второй <link>, обычно media="not all") И принудительно сужаем .main до ширины
// листа: иначе меряли бы вёрстку по ширине окна, а она шире бумаги в разы.
//
// Ширина сетки от шрифта не зависит (table-layout: fixed + width: 100%), поэтому
// увеличение текста уходит целиком в высоту строк — туда, где на книжном листе
// остаётся свободное место.
(function () {
  'use strict';

  const MM_TO_PX = 96 / 25.4; // CSS-пиксели в миллиметре при 96 dpi
  const PAGE = { width: 210, height: 297, margin: 8 }; // A4, книжная, поля как в @page
  const PAGE_W = (PAGE.width - PAGE.margin * 2) * MM_TO_PX;
  const PAGE_H = (PAGE.height - PAGE.margin * 2) * MM_TO_PX;
  const FONT = { min: 4, max: 16, steps: 8 }; // пункты; 8 делений пополам ≈ 0.05pt
  const MIN_ZOOM = 0.15;
  const ZOOM_PASSES = 4; // сходится за 2–3, четвёртый — запас
  // Запас по высоте (~6 мм). Подгонка «впритык» не работает: у подвала и строк
  // стоит break-inside: avoid, и при нехватке пары пикселей блок целиком уезжает
  // на второй лист. Плюс печать идёт не в тех же пикселях, что замер на экране.
  const SLACK = 24;

  const root = document.documentElement;
  const setVar = (name, value) => root.style.setProperty(name, value);

  // Высота textarea в подвале подогнана под ЭКРАННЫЙ шрифт (админка растит её по
  // содержимому). В печатной раскладке шрифт мельче — пересчитываем, иначе подвал
  // занимает лишнее место. После замера то же делаем обратно для экрана.
  function regrowTextareas(area) {
    area.querySelectorAll('textarea.subj-input').forEach((el) => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    });
  }

  // Высота содержимого при данном масштабе и шрифте, в «бумажных» пикселях.
  // При zoom = z полоса вёрстки шире листа в 1/z раз — так браузер и печатает.
  function measure(area, zoom, fontPt) {
    area.style.width = `${PAGE_W / zoom}px`;
    setVar('--print-grid-font', `${fontPt}pt`);
    regrowTextareas(area);
    return area.scrollHeight * zoom;
  }

  function fitToPage() {
    const preview = document.getElementById('printPreviewCss');
    const area = document.querySelector('.main');
    if (!preview || !area) return;

    const savedWidth = area.style.width;
    setVar('--print-zoom', '1');
    setVar('--print-row-h', 'auto');
    preview.media = 'all'; // печатная раскладка на экране (на доли секунды)

    // 1) Масштаб. Обычно 1: по ширине сетка вписывается сама. Уменьшаем, только
    //    если даже минимальный шрифт не лезет по высоте. Уменьшение помогает
    //    вдвойне: полоса становится шире, текст меньше переносится.
    let zoom = 1;
    for (let i = 0; i < ZOOM_PASSES; i++) {
      const height = measure(area, zoom, FONT.min);
      if (height <= PAGE_H - SLACK) break;
      zoom = Math.max(zoom * ((PAGE_H - SLACK) / height), MIN_ZOOM);
      if (zoom === MIN_ZOOM) break;
    }

    // 2) Шрифт сетки — наибольший, при котором содержимое ещё влезает по высоте.
    let lo = FONT.min;
    let hi = FONT.max;
    let best = FONT.min;
    for (let i = 0; i < FONT.steps; i++) {
      const mid = (lo + hi) / 2;
      if (measure(area, zoom, mid) <= PAGE_H - SLACK) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const height = measure(area, zoom, best);

    // 3) Остаток высоты раздаём строкам сетки: шрифт растёт скачками (перенос
    //    строк), поэтому после подбора остаётся несколько миллиметров пустоты.
    const table = area.querySelector('#gridWrap table');
    const rows = table && table.tBodies[0] ? table.tBodies[0].rows.length : 0;
    if (rows && height < PAGE_H - SLACK) {
      const extra = (PAGE_H - SLACK - height) / zoom / rows;
      setVar('--print-row-h', `${Math.floor(table.tBodies[0].rows[0].offsetHeight + extra)}px`);
      // Строка не может стать ниже содержимого — если перебрали, снимаем.
      if (area.scrollHeight * zoom > PAGE_H - SLACK) setVar('--print-row-h', 'auto');
    }

    setVar('--print-zoom', String(zoom));
    area.style.width = savedWidth; // вернуть экранную ширину
    preview.media = 'not all'; // вернуть экранный вид
    // ВАЖНО: высоты textarea в подвале оставляем печатными. Если вернуть их
    // здесь, на бумагу уйдёт подвал, раздутый под экранный шрифт (проверено:
    // 1250 px вместо 1062), и он вытолкнет всё на второй лист. Экранные размеры
    // восстанавливаем после печати.
  }

  window.addEventListener('beforeprint', fitToPage);
  window.addEventListener('afterprint', () => {
    const area = document.querySelector('.main');
    if (area) regrowTextareas(area);
  });
})();
