'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Temporary file lives on the same volume: readers see either complete version.
function atomicWrite(file, contents, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', options.mode || 0o600);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}

module.exports = { atomicWrite };
