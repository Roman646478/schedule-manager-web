'use strict';

const iconv = require('iconv-lite');

/**
 * Декодирование HTML-экспорта расписания.
 * Файлы примеров — в UTF-8 (проверено по сырым байтам), но содержат единичные
 * «битые» байты, из-за которых strict-декодирование падает. При этом встречаются
 * и настоящие cp1251-выгрузки. Поэтому: декодируем обоими способами с заменой
 * нечитаемых байтов и выбираем вариант с МЕНЬШИМ числом символов-замен (�).
 */
function decodeBuffer(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const utf8Bad = countReplacements(utf8);
  if (utf8Bad === 0) return utf8;
  // Единичные битые байты (1С иногда обрезает мультибайтовый символ) — файл
  // всё равно UTF-8: у настоящего cp1251-файла с русским текстом невалиден
  // почти каждый байт кириллицы, а не доли процента. Сравнение по числу U+FFFD
  // тут не работает: win1251 декодирует ЛЮБЫЕ байты без замен и «выигрывал»,
  // превращая почти корректный UTF-8 в кракозябру.
  if (utf8Bad <= Math.max(4, buf.length / 1000)) return utf8;
  const cp1251 = iconv.decode(buf, 'win1251');
  const cp1251Bad = countReplacements(cp1251);
  return cp1251Bad < utf8Bad ? cp1251 : utf8;
}

function countReplacements(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) === 0xfffd) n++;
  return n;
}

function isValidUtf8(buf) {
  return countReplacements(new TextDecoder('utf-8', { fatal: false }).decode(buf)) === 0;
}

/** Нормализация строки: убрать &nbsp;, лишние пробелы, soft-hyphen. */
function clean(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&nbsp;/gi, ' ')
    .replace(/­/g, '') // soft hyphen
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Извлекает только ФИО преподавателя из строки расписания.
 * Формат источника: [звание] Фамилия И.О. [учёная степень/звание].
 * Напр. «п/п-к Казаков Р.Р. ктн доц» → «Казаков Р.Р.»,
 *       «Алдохина В.Н. кфмн доц»     → «Алдохина В.Н.».
 * Звание (м-р, п/п-к, п-к…) идёт до фамилии, степень (ктн, доц…) — после
 * инициалов; и то, и другое отбрасываем. Если ФИО не распознано — оставляем как есть.
 */
function teacherFio(raw) {
  const s = clean(raw);
  if (!s) return s;
  // Фамилия (возможно через дефис) + инициалы вида «И.О.» или «И.».
  const m = s.match(/([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)\s+([А-ЯЁ]\.\s*[А-ЯЁ]?\.?)/);
  if (!m) return s;
  return `${m[1]} ${m[2].replace(/\s+/g, '')}`;
}

/**
 * Канонический формат имени группы. В файлах групп имя пишется через дефис
 * (843-12), а в ячейках файлов аудиторий и преподавателей — через слэш (843/12).
 * Это одна и та же группа: приводим к дефису, чтобы не плодить дубли в БД и
 * корректно сшивать три представления.
 */
function normalizeGroup(name) {
  return clean(name).replace(/\//g, '-');
}

/**
 * Канонический формат имени аудитории. В разных файлах аббревиатуры пишутся
 * по-разному: «сп.зал» (без пробела) и «сп. зал» (с пробелом). Приводим к
 * форме с пробелом после точки перед буквой, чтобы сшивать три представления.
 */
function normalizeRoom(name) {
  return clean(name).replace(/\.([а-яёА-ЯЁa-zA-Z])/g, '. $1');
}

/** Группировка массива по ключу (или функции-ключу). */
function groupBy(arr, key) {
  const keyFn = typeof key === 'function' ? key : (x) => x[key];
  const out = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

module.exports = { decodeBuffer, isValidUtf8, clean, teacherFio, normalizeGroup, normalizeRoom, groupBy };
