/* Чистый парсер учебного плана (xlsx «План учебного процесса», ФГОС-форма).
   Без DOM и без зависимостей — работает и в браузере, и в Node (см. экспорт внизу).
   Вход: aoa — массив строк (sheet_to_json(ws, {header:1, raw:true})), колонки 0-based. */

// 0-based индексы колонок (см. карту в плане)
const COL = {
  num: 0, index: 1, name: 2,
  zeMand: 3, zeVar: 4, totalHours: 5, audTotal: 6,
  types: { lectures: 7, seminars: 8, labs: 9, practicals: 10, groupExercises: 11,
    groupClasses: 12, tactical: 13, kshu: 14, conferences: 15, control: 16,
    consultations: 17, coursework: 18, other: 19 },
  zachetInSem: 20, selfStudy: 21, sessionZe: 22,
  semStart: 23,            // X; семестр i (1..10): aud = 23+3*(i-1), self +1, sessZe +2
  exams: 53, zachetsGraded: 54, zachetsUngraded: 55, // BB, BC, BD
};

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function isInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;
}

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

// Ячейка экз/зач → список семестров. Может быть int (4), строкой ('2,4,6,8,10')
// или float (Excel сохранил «1,3» как 1.3). Неоднозначное — в warnings, не угадываем.
function parseSemList(v, warnings, ctx) {
  if (v === null || v === undefined || v === '') return [];
  let parts;
  if (typeof v === 'number') {
    parts = Number.isInteger(v) ? [v] : String(v).split('.');
  } else {
    parts = String(v).split(/[.,;\s]+/);
  }
  const out = [];
  for (const p of parts) {
    const s = String(p).trim();
    if (s === '') continue;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      warnings.push(`Подозрительное значение семестра «${v}» (${ctx})`);
      continue;
    }
    out.push(n); // дубли не убираем — нужны для распознавания курсовой (см. parseAssessment)
  }
  return out;
}

// Ячейка экз/зач с учётом курсовой. Если у дисциплины есть курсовая (часы в кол. S)
// и в ячейке два числа — второе это семестр курсовой, а не второй экз/зачёт
// (напр. «4,4» = зачёт в сем.4 + курсовая в сем.4). Без курсовой два числа = список.
function parseAssessment(v, hasCoursework, warnings, ctx) {
  const nums = parseSemList(v, warnings, ctx);
  if (hasCoursework && nums.length === 2) {
    return { sems: [nums[0]], courseworkSem: nums[1] };
  }
  return { sems: [...new Set(nums)], courseworkSem: null };
}

const WEEK_HOURS = 54; // 1 неделя практики = 1.5 з.е. = 54 ак. часа

function buildItem(row, kind, cycle, module, warnings) {
  const byType = {};
  for (const [k, idx] of Object.entries(COL.types)) byType[k] = num(row[idx]);
  const isPractice = kind === 'practice'; // у практик F и семестры — НЕДЕЛИ, не часы
  const conv = (v) => (isPractice ? Math.round(num(v) * WEEK_HOURS) : num(v));

  const perSemester = [];
  for (let i = 0; i < 10; i++) {
    const base = COL.semStart + 3 * i;
    const e = { aud: conv(row[base]), self: conv(row[base + 1]), sessZe: num(row[base + 2]) };
    if (isPractice) e.weeks = num(row[base]); // исходные недели для практик
    perSemester.push(e);
  }
  const name = str(row[COL.name]);
  const ctx = str(row[COL.index]) || name;

  const courseworkHours = num(row[COL.types.coursework]); // кол. S «Выполнение курсовых работ»
  const ex = parseAssessment(row[COL.exams], courseworkHours > 0, warnings, `экз. ${ctx}`);
  const zo = parseAssessment(row[COL.zachetsGraded], courseworkHours > 0, warnings, `зач.с оц. ${ctx}`);
  const zb = parseAssessment(row[COL.zachetsUngraded], courseworkHours > 0, warnings, `зач.без оц. ${ctx}`);

  const exams = ex.sems;
  let zachetsGraded = zo.sems;
  // Курсовая. Два способа кодирования в плане:
  //  A) часы в кол. S + «X,Y» в ячейке экз/зач → курсовая в сем.Y (Д.12.О);
  //  B) экзамен и зачёт-с-оценкой по дисциплине в одном семестре → это курсовой
  //     проект, а не отдельный зачёт (Д.28.О). Убираем такой «зачёт» из списка.
  let coursework = courseworkHours > 0
    ? { hours: courseworkHours, semester: ex.courseworkSem ?? zo.courseworkSem ?? zb.courseworkSem ?? null, kind: 'work' }
    : null;
  const coincide = zachetsGraded.filter((s) => exams.includes(s));
  if (coincide.length) {
    zachetsGraded = zachetsGraded.filter((s) => !coincide.includes(s));
    if (!coursework) coursework = { hours: 0, semester: coincide[0], kind: 'project' };
  }

  return {
    kind, cycle, module,
    index: str(row[COL.index]),
    name,
    ze: { mandatory: num(row[COL.zeMand]), variable: num(row[COL.zeVar]) },
    totalHours: conv(row[COL.totalHours]),
    weeks: isPractice ? num(row[COL.totalHours]) : null,
    audTotal: conv(row[COL.audTotal]),
    byType,
    coursework,
    zachetInSemHours: num(row[COL.zachetInSem]),
    selfStudy: conv(row[COL.selfStudy]),
    sessionZe: num(row[COL.sessionZe]),
    perSemester,
    exams,
    zachetsGraded,
    zachetsUngraded: zb.sems,
  };
}

// Контрольные суммы из строк-сводки (низ листа): кол-во экзаменов/зачётов по семестрам.
function extractSummary(aoa) {
  const out = {};
  const map = { 'экзаменов': 'exams', 'зачетов с оценкой': 'zachetsGraded',
    'зачетов без оценки': 'zachetsUngraded', 'дисциплин (модулей)': 'disciplines' };
  for (const row of aoa) {
    const key = map[str(row[COL.index]).toLowerCase()];
    if (!key) continue;
    const perSem = [];
    for (let i = 0; i < 10; i++) perSem.push(num(row[COL.semStart + 3 * i]));
    out[key] = perSem;
  }
  return out;
}

const normName = (s) => str(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const RESERVE_RE = /за сч[еёе]т резерва/i;

// Строка «… за счёт резерва времени» (без № и индекса) — это не отдельная
// дисциплина, а добавочные часы к предыдущей (напр. «Физическая подготовка»).
// Сливаем её аудиторные часы (по семестрам и итог) в целевую дисциплину.
function mergeReserve(target, row) {
  for (let i = 0; i < 10; i++) target.perSemester[i].aud += num(row[COL.semStart + 3 * i]);
  const g = num(row[COL.audTotal]);
  target.audTotal += g;
  target.totalHours += g;
  target.byType.practicals += num(row[COL.types.practicals]);
  target.reserveHours = (target.reserveHours || 0) + g;
}

function parseCurriculum(aoa, fileName = '') {
  const warnings = [];
  const disciplines = [];
  let cycle = null, module = null;

  for (const row of aoa) {
    const a = row[COL.num];
    const b = str(row[COL.index]);
    const c = str(row[COL.name]);

    if (str(a).toLowerCase().startsWith('кол-во')) break; // дошли до сводки

    if (isInt(a)) {
      disciplines.push(buildItem(row, b ? 'discipline' : 'practice', cycle, module, warnings));
    } else if (!a) {
      if (c && RESERVE_RE.test(c) && disciplines.length) {
        const t = disciplines.find((d) => normName(c).startsWith(normName(d.name))) || disciplines[disciplines.length - 1];
        mergeReserve(t, row);
      } else if (b.startsWith('Блок')) { /* заголовок блока — пропуск */ }
      else if (b.startsWith('М.')) module = c || b;
      else if (b.startsWith('ДИСЦИПЛИНЫ') || c) cycle = c || b;
    }
  }

  // Само-сверка: посчитать экз/зач по семестрам из дисциплин и сравнить со сводкой.
  // Сводка считает только дисциплины (модули), без практик — практики тоже несут
  // зачёты, но в строки-сводки не попадают, поэтому при сверке их исключаем.
  const summary = extractSummary(aoa);
  const countBySem = (field) => {
    const c = Array(11).fill(0);
    for (const d of disciplines) {
      if (d.kind !== 'discipline') continue;
      for (const s of d[field]) c[s]++;
    }
    return c;
  };
  for (const field of ['exams', 'zachetsGraded']) {
    if (!summary[field]) continue;
    const got = countBySem(field);
    for (let s = 1; s <= 10; s++) {
      const stated = summary[field][s - 1];
      if (got[s] !== stated) {
        warnings.push(`Сверка ${field}: семестр ${s} — в плане ${stated}, разобрано ${got[s]}`);
      }
    }
  }

  const m = String(fileName).match(/(\d{2})/);
  const kafedra = m ? m[1] : '';

  return { kafedra, fileName, disciplines, summary, warnings };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCurriculum, parseSemList, extractSummary, COL };
}
