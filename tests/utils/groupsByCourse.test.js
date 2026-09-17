'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { groupsByCourse, courseGroupsHtml, courseOptionsHtml } = require('../../public/js/shared-constants.js');

// Курс группы берётся по первым двум символам имени (окно «Курсы»).
const COURSES = { 86: 1, 85: 2, 84: 3 };

test('groupsByCourse: блоки по возрастанию курса, «Без курса» — в конце', () => {
  const blocks = groupsByCourse(['851-11', '999', '861-12', '841-11', '861-11'], COURSES);
  assert.deepEqual(
    blocks.map((b) => [b.label, b.groups]),
    [
      ['1 курс', ['861-11', '861-12']],
      ['2 курс', ['851-11']],
      ['3 курс', ['841-11']],
      ['Без курса', ['999']],
    ]
  );
});

test('groupsByCourse: курсы не заданы — один блок «Без курса»', () => {
  const blocks = groupsByCourse(['861-11', '851-11'], {});
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].course, null);
});

test('courseGroupsHtml: в каждом блоке заголовок-чекбокс на весь курс', () => {
  const html = courseGroupsHtml(['861-11', '851-11'], COURSES, (g) => `<i>${g}</i>`);
  assert.equal((html.match(/class="crs-block"/g) || []).length, 2);
  assert.equal((html.match(/class="crs-all"/g) || []).length, 2);
  assert.ok(html.includes('<b>1 курс</b>') && html.includes('<i>861-11</i>'));
});

test('courseOptionsHtml: без курсов список плоский, с курсами — optgroup', () => {
  const option = (g) => `<option>${g}</option>`;
  assert.equal(courseOptionsHtml(['861-11'], {}, option), '<option>861-11</option>');
  const html = courseOptionsHtml(['861-11', '851-11'], COURSES, option);
  assert.ok(html.startsWith('<optgroup label="1 курс">'));
  assert.equal((html.match(/<optgroup/g) || []).length, 2);
});
