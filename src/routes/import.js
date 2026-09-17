'use strict';

const { commandRouter } = require('../middleware/mutations');
const multer = require('multer');
const { boundedMemoryStorage } = require('../middleware/boundedUpload');
const { requireAuth } = require('../middleware/auth');
const { importFiles } = require('../services/importService');
const { getSemester, getSubjectAliases } = require('../services/settingsService');

const router = commandRouter();

const MAX_FILE_BYTES = 2 * 1024 * 1024; // HTML-расписание весит десятки КБ — 2 МБ с запасом
const MAX_FILES = 1200; // ~1000 преподавателей за раз с запасом

// Принимаем только HTML (по расширению или MIME) — прочее молча отбрасываем.
function fileFilter(req, file, cb) {
  const ok = /\.html?$/i.test(file.originalname) || /html/i.test(file.mimetype || '');
  cb(null, ok);
}

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
router.post('/import', requireAuth, handleUpload, (req, res, next) => {
  try {
    // Имя файла нужно отчёту (problemFiles): по нему фронт находит исходный File
    // для повторного импорта с ручным сдвигом.
    const files = (req.files || []).map((f) => ({ buffer: f.buffer, name: f.originalname }));
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
  } catch (err) {
    next(err);
  }
});

module.exports = router;
