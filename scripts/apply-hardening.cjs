const fs = require('fs');
function edit(file, fn) { const before = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, fn(before)); }
edit('src/server.js', s => {
  s = s.replace("const { getSetting, setSetting }", "const { getSetting }");
  s = s.replace("const { sortTopics } = require('./services/topicOrderService');", "const { sortTopics } = require('./services/topicOrderService');\nconst { finalizeMutation } = require('./middleware/mutations');\nconst { transaction } = require('./services/dbService');\nconst { flushSnapshot } = require('./services/snapshotStore');\nconst { randomUUID } = require('crypto');");
  const start = s.indexOf('  // Счётчик изменений данных:');
  const end = s.indexOf('  // Роуты API', start);
  if (start < 0 || end < 0) throw Error('server markers');
  s = s.slice(0, start) + `  const epoch = randomUUID();
  app.use('/api', (req, res, next) => {
    const json = res.json;
    res.json = function (body) {
      try { transaction(() => finalizeMutation(req, res)); }
      catch (err) { return next(err); }
      return json.call(this, body);
    };
    next();
  });
  app.get('/api/data-version', (req, res) => res.json({ version: Number(getSetting('dataVersion') || 0), epoch }));

` + s.slice(end);
  s = s.replace('  getDb(); //', '  getDb();\n  flushSnapshot(); // Recover a publication interrupted after the database commit.\n  //');
  return s;
});
for (const name of ['schedule', 'import', 'rooms', 'curriculum']) edit(`src/routes/${name}.js`, s => s.replace("const express = require('express');", "const { commandRouter } = require('../middleware/mutations');").replace('express.Router()', 'commandRouter()'));
edit('src/services/scheduleService.js', s => {
  s = s.replace("const zlib = require('zlib');", "const { writeSnapshot, readSnapshot } = require('./snapshotStore');\nconst { sortTopics } = require('./topicOrderService');");
  const start = s.indexOf('// Снимок пишется без отступов');
  const end = s.indexOf('// Есть ли правки,', start);
  s = s.slice(0, start) + s.slice(end);
  s = s.replace('function publish(db = getDb()) {', 'function publish(db = getDb()) {\n  sortTopics();');
  s = s.replace('  const result = editLesson(lessonId, patch);\n  if (result.ok) patchPublished(lessonId, patch);\n  return result;', `  const snap = readSnapshot();
  if (!snap || !(snap.lessons || []).some(l => l.id === lessonId)) return { ok: false, code: 409, reasons: ['Занятие отсутствует в публикации. Обновите страницу.'] };
  return transaction(() => {
    const result = editLesson(lessonId, patch);
    if (result.ok) {
      sortTopics();
      patchPublished(lessonId, patch);
    }
    return result;
  });`);
  const pstart = s.indexOf('function patchPublished(');
  const pend = s.indexOf('// Статистика нагрузки:', pstart);
  s = s.slice(0, pstart) + `function patchPublished(lessonId, patch) {
  const snap = readSnapshot();
  if (!snap) return;
  const l = (snap.lessons || []).find(x => x.id === lessonId);
  if (!l) return;
  const current = getDb().prepare('SELECT topic, note, type FROM lessons WHERE id = ?').get(lessonId);
  for (const key of Object.keys(patch)) l[key] = current[key] ?? null;
  writeSnapshot(snap);
}

` + s.slice(pend);
  return s;
});
edit('public/js/admin.js', s => s.replace('  async function render() {', '  let renderGeneration = 0;\n  async function render() {\n    const generation = ++renderGeneration;').replace('    await Promise.all([loadMoveMarks(), syncPublishState()]);', '    await Promise.all([loadMoveMarks(), syncPublishState()]);\n    if (generation !== renderGeneration) return;').replace('    state.lessons = data.lessons || [];', '    if (generation !== renderGeneration) return;\n    state.lessons = data.lessons || [];').replace('weekNo > 26', 'weekNo > semesterWeeks()'));
edit('public/js/guest.js', s => {
  const fn = fs.readFileSync('public/js/admin.js','utf8').match(/  function semesterWeeks\(\) \{[\s\S]*?\n  \}/)[0].replace('const sem = state.semester;', 'const sem = state.data && state.data.semester;').replace('(state.lessons || [])', '(state.data && state.data.lessons || [])');
  return s.replace('  function stepWeek(delta) {', fn + '\n\n  function stepWeek(delta) {').replace('length: 26', 'length: semesterWeeks()').replaceAll('Math.min(26,', 'Math.min(semesterWeeks(),');
});
edit('public/js/api.js', s => s.replace('    let known = null;', '    let known = null;\n    let knownEpoch = null;\n    let polling = false;').replace('      if (document.hidden) return;\n      let version;', '      if (document.hidden || polling) return;\n      polling = true;\n      try {\n      let version, epoch;').replace("        version = (await request('GET', '/api/data-version')).version;", "        ({ version, epoch } = await request('GET', '/api/data-version'));").replace('      if (delta <= 0) { known = version; return; } // рестарт сервера обнуляет счётчик — просто запоминаем', `      const restarted = known !== null && (epoch !== knownEpoch || delta < 0);
      if (!restarted && delta <= 0) { known = version; knownEpoch = epoch; selfChanges = 0; return; }`).replace('      const mine = Math.min(delta, selfChanges);', '      const mine = restarted ? 0 : Math.min(delta, selfChanges);').replace('      if (delta > mine) {', '      if (restarted || delta > mine) {').replace('try { busy = (await onChange()) === false; } catch { /* колбэк упал — версию всё равно запоминаем */ }', 'try { busy = (await onChange()) === false; } catch { return; }').replace('      known = version;\n      selfChanges -= mine;', '      known = version;\n      knownEpoch = epoch;\n      selfChanges = 0;\n      } finally { polling = false; }'));
