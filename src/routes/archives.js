'use strict';

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const {
  isValidArchiveId,
  listArchives,
  createArchive,
  setArchiveNote,
  deleteArchive,
  getArchiveFile,
  importArchive,
  restoreArchive,
} = require('../services/archiveService');

const router = express.Router();

// Снимок реальной базы весит единицы мегабайт (VACUUM сжимает), но у крупного
// вуза база может вырасти — берём с большим запасом.
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

const uploadArchive = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ARCHIVE_BYTES, files: 1 },
}).array('files', 1);

function handleArchiveUpload(req, res, next) {
  uploadArchive(req, res, (err) => {
    if (!err) return next();
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Файл больше ${MAX_ARCHIVE_BYTES / (1024 * 1024)} МБ`
        : err.code === 'LIMIT_FILE_COUNT'
          ? 'Загружайте по одному файлу'
          : 'Ошибка загрузки файла';
    res.status(400).json({ error: msg });
  });
}

// Идентификатор архива приходит от клиента и превращается в имя файла —
// проверяем его до любой работы с диском.
function checkId(req, res) {
  if (isValidArchiveId(req.params.id)) return true;
  res.status(400).json({ error: 'Некорректный идентификатор архива' });
  return false;
}

// Отдаёт доменный отказ сервиса ({ok:false, code, error}) как HTTP-ответ.
function sendResult(res, result) {
  if (!result.ok) return res.status(result.code || 409).json({ error: result.error });
  res.json(result);
}

// Список снимков базы (новые сверху).
router.get('/archives', requireAuth, (req, res, next) => {
  try {
    res.json({ archives: listArchives() });
  } catch (err) {
    next(err);
  }
});

// Сохранить текущее состояние базы новым снимком: { note }.
router.post('/archives', requireAuth, (req, res, next) => {
  try {
    res.json({ success: true, archive: createArchive({ note: (req.body || {}).note }) });
  } catch (err) {
    next(err);
  }
});

// Выгрузить файл версии на устройство пользователя. Файл самодостаточен:
// примечание и дата лежат внутри него, поэтому на другом устройстве версия
// опознаётся без каких-либо сопроводительных данных.
router.get('/archives/:id/download', requireAuth, (req, res, next) => {
  try {
    if (!checkId(req, res)) return;
    const result = getArchiveFile(req.params.id);
    if (!result.ok) return res.status(result.code || 404).json({ error: result.error });
    res.download(result.path, result.filename);
  } catch (err) {
    next(err);
  }
});

// Принять файл версии с другого устройства. Поле формы — "files" (как в импорте
// расписания), необязательное поле "note" перебивает примечание из файла.
router.post('/archives/import', requireAuth, handleArchiveUpload, (req, res, next) => {
  try {
    const file = (req.files || [])[0];
    if (!file) return res.status(400).json({ error: 'Не передан файл версии' });
    sendResult(res, importArchive(file.buffer, { note: (req.body || {}).note }));
  } catch (err) {
    next(err);
  }
});

// Изменить примечание к снимку: { note }.
router.put('/archives/:id', requireAuth, (req, res, next) => {
  try {
    if (!checkId(req, res)) return;
    sendResult(res, setArchiveNote(req.params.id, (req.body || {}).note));
  } catch (err) {
    next(err);
  }
});

router.delete('/archives/:id', requireAuth, (req, res, next) => {
  try {
    if (!checkId(req, res)) return;
    sendResult(res, deleteArchive(req.params.id));
  } catch (err) {
    next(err);
  }
});

// Переключиться на выбранный снимок. Текущее состояние перед этим уходит
// в автоснимок, поэтому откат обратим.
router.post('/archives/:id/restore', requireAuth, (req, res, next) => {
  try {
    if (!checkId(req, res)) return;
    sendResult(res, restoreArchive(req.params.id));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
