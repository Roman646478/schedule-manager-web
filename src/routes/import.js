'use strict';

const { commandRouter } = require('../middleware/mutations');
const multer = require('multer');
const { boundedMemoryStorage } = require('../middleware/boundedUpload');
const { requireAdmin: requireAuth } = require('../middleware/auth');
const { importFiles } = require('../services/importService');
const { parseSchedule } = require('../parsers/htmlScheduleParser');
const { parseExcelSchedule } = require('../parsers/excelScheduleParser');
const { getSemester, getSubjectAliases } = require('../services/settingsService');

const router = commandRouter();

const MAX_FILE_BYTES = 10 * 1024 * 1024; // Excel с оформлением заметно крупнее HTML
const MAX_FILES = 1200; // ~1000 преподавателей за раз с запасом

// Принимаем HTML и Excel-расписания.
// Browsers send multipart filenames as UTF-8, while busboy decodes those bytes
// as latin1. Restore the original name so it still matches File.name in the UI.
function normalizeUploadName(name) {
  const source = String(name || '');
  if (!/[\u00c0-\u00ff]/.test(source)) return source;
  const decoded = Buffer.from(source, 'latin1').toString('utf8');
  return decoded.includes('\ufffd') ? source : decoded;
}

function fileFilter(req, file, cb) {
  const ok = /\.(html?|xlsx)$/i.test(file.originalname) || /(html|spreadsheetml)/i.test(file.mimetype || '');
  cb(null, ok);
}

async function parsedFiles(uploaded) {
  return Promise.all((uploaded || []).map(async (file) => {
    const name = normalizeUploadName(file.originalname);
    const parsed = /\.xlsx$/i.test(name)
      ? await parseExcelSchedule(file.buffer, name)
      : parseSchedule(file.buffer);
    return { buffer: file.buffer, name, parsed };
  }));
}

function prepareUploaded(req, res, next) {
  parsedFiles(req.files).then((files) => { req.importFiles = files; next(); }, next);
}

const sampleOf = (lesson) => ({
  day: lesson.day, pairNo: lesson.pairNo, weekNo: lesson.weekNo,
  type: lesson.type, topic: lesson.topic, subject: lesson.subject,
  room: (lesson.rooms || []).join(', '),
});

router.post('/import/preview', requireAuth, handleUpload, prepareUploaded, (req, res) => {
  try {
    const files = req.importFiles;
    if (!files.length) return res.status(400).json({ error: 'Не переданы файлы' });
    res.json({ files: files.map(({ name, parsed }) => ({
      name,
      kind: parsed.kind,
      owner: parsed.owner,
      format: parsed.excelFormat || 'html',
      gridRow: parsed.gridRow || null,
      firstDate: parsed.firstDate || null,
      weeks: (parsed.weeks || []).filter((w) => w.weekNo).length,
      lessons: (parsed.lessons || []).length,
      examples: (parsed.lessons || []).filter((l) => l.category !== 'event').slice(0, 4).map(sampleOf),
    })) });
  } catch (err) { throw err; }
});

const upload = multer({
  storage: boundedMemoryStorage(64 * 1024 * 1024),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 10, fieldSize: 8192, parts: MAX_FILES + 10 },
  fileFilter,
});
const uploadFiles = upload.array('files', MAX_FILES);

// Обёртка: ошибки multer (превышение размера/числа файлов) → понятный 400.
function handleUpload(req, res, next) {
  uploadFiles(req, res, (err) => {
    if (!err) return next();
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Файл больше ${MAX_FILE_BYTES / (1024 * 1024)} МБ или весь набор больше 64 МБ; загрузите файлы частями`
        : err.code === 'LIMIT_FILE_COUNT'
          ? `Слишком много файлов (максимум ${MAX_FILES})`
          : 'Ошибка загрузки файлов';
    res.status(400).json({ error: msg });
  });
}

// Ручной сдвиг недель из тела запроса. Пусто/нет → null (авто по датам файла).
function parseManualOffset(body) {
  const raw = body && body.weekOffset;
  if (raw == null || raw === '' || raw === 'auto') return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(-52, Math.min(52, n));
}

// Загрузка набора HTML-файлов (группы/аудитории/преподаватели) и сборка
// единого источника. Поле формы — "files".
router.post('/import', requireAuth, handleUpload, prepareUploaded, (req, res) => {
  try {
    // Имя файла нужно отчёту (problemFiles): по нему фронт находит исходный File
    // для повторного импорта с ручным сдвигом.
    const files = req.importFiles;
    if (!files.length) return res.status(400).json({ error: 'Не переданы файлы' });
    const mode = req.body && req.body.mode === 'replace' ? 'replace' : 'merge';
    const report = importFiles(files, mode, {
      semester: getSemester(),
      manualOffset: parseManualOffset(req.body),
      subjectAliases: getSubjectAliases(),
      // Отсев лишних преподавателей включён по умолчанию; 'false' — без сравнения.
      filterTeachers: !(req.body && String(req.body.filterTeachers) === 'false'),
    });
    res.json({ success: true, report });
  } catch (err) { throw err; }
});

module.exports = router;
module.exports.normalizeUploadName = normalizeUploadName;
