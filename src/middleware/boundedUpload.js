'use strict';

const multer = require('multer');

// Bound the complete batch, not just each of up to 1200 individual files.
function boundedMemoryStorage(maxBytes) {
  const totals = new WeakMap();
  return {
    _handleFile(req, file, cb) {
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        cb(err, err ? undefined : { buffer: Buffer.concat(chunks, size), size });
      };
      file.stream.on('data', (chunk) => {
        if (done) return;
        const total = (totals.get(req) || 0) + chunk.length;
        totals.set(req, total);
        if (total > maxBytes) {
          chunks.length = 0;
          return finish(new multer.MulterError('LIMIT_FILE_SIZE', 'files'));
        }
        size += chunk.length;
        chunks.push(chunk);
      });
      file.stream.on('error', finish);
      file.stream.on('end', () => finish());
    },
    _removeFile(req, file, cb) {
      delete file.buffer;
      cb(null);
    },
  };
}

module.exports = { boundedMemoryStorage };
