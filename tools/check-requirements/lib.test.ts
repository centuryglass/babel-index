import test from 'node:test';
import assert from 'node:assert/strict';
import { coverage, parseRequirements, parseTags, verdict } from './lib.ts';

const DOC = `# Search requirements

Preamble prose that is not a requirement.

## Finding

- **SR-01** Search should find things.
- **SR-02** Search should match a word that wraps
  onto a second line.
- **SR-03** Search should feel right. _(judged)_

## Ranking

- **SR-04** Search should rank.
`;

test('every requirement is parsed, in document order', () => {
  const reqs = parseRequirements(DOC);
  assert.deepEqual(reqs.map((r) => r.id), ['SR-01', 'SR-02', 'SR-03', 'SR-04']);
});

test('a wrapped requirement is one requirement, with its text rejoined', () => {
  const reqs = parseRequirements(DOC);
  assert.equal(reqs[1].text, 'Search should match a word that wraps onto a second line.');
});

test('the judged marker is read off the document and stripped from the text', () => {
  const judged = parseRequirements(DOC).find((r) => r.id === 'SR-03');
  assert.equal(judged?.judged, true);
  assert.equal(judged?.text, 'Search should feel right.');
  assert.equal(parseRequirements(DOC)[0].judged, false);
});

test('prose between sections never becomes a requirement', () => {
  assert.equal(parseRequirements(DOC).length, 4);
});

test('a duplicate id throws rather than making coverage ambiguous', () => {
  assert.throws(() => parseRequirements('- **SR-01** one.\n- **SR-01** two.\n'), RangeError);
});

test('tags are read wherever they appear, and deduped', () => {
  const tags = parseTags("test('a thing [SR-01] and again [SR-01] plus [SR-04]', () => {});");
  assert.deepEqual([...tags].sort(), ['SR-01', 'SR-04']);
});

test('text that merely looks like a tag is not one', () => {
  assert.equal(parseTags('[SR-1] [sr-01] [SR-001] SR-01').size, 0);
});

const REQS = parseRequirements(DOC);

test('coverage splits covered, uncovered and judged', () => {
  const report = coverage({
    requirements: REQS,
    tagsByFile: new Map([['a.test.ts', new Set(['SR-01'])]]),
  });
  assert.deepEqual(report.covered, ['SR-01']);
  assert.deepEqual(report.uncovered, ['SR-02', 'SR-04']);
  assert.deepEqual(report.judged, ['SR-03']);
});

test('a judged requirement that does get a test counts as covered, not judged', () => {
  const report = coverage({
    requirements: REQS,
    tagsByFile: new Map([['a.test.ts', new Set(['SR-03'])]]),
  });
  assert.deepEqual(report.covered, ['SR-03']);
  assert.deepEqual(report.judged, []);
});

test('a tag naming no requirement is reported with the file it came from', () => {
  const report = coverage({
    requirements: REQS,
    tagsByFile: new Map([['a.test.ts', new Set(['SR-99'])]]),
  });
  assert.deepEqual(report.dangling, [{ id: 'SR-99', file: 'a.test.ts' }]);
});

test('every file covering a requirement is recorded, sorted', () => {
  const report = coverage({
    requirements: REQS,
    tagsByFile: new Map([
      ['b.test.ts', new Set(['SR-01'])],
      ['a.test.ts', new Set(['SR-01'])],
    ]),
  });
  assert.deepEqual(report.filesById.get('SR-01'), ['a.test.ts', 'b.test.ts']);
});

test('losing coverage the baseline did not allow is a regression', () => {
  const report = coverage({ requirements: REQS, tagsByFile: new Map() });
  const v = verdict(report, { uncovered: ['SR-02'] });
  assert.deepEqual(v.regressions, ['SR-01', 'SR-04']);
  assert.equal(v.ok, false);
});

test('an empty baseline allows nothing to be uncovered', () => {
  const report = coverage({ requirements: REQS, tagsByFile: new Map() });
  assert.equal(verdict(report, { uncovered: [] }).ok, false);
});

test('gaining coverage is never a failure, only a note', () => {
  const report = coverage({
    requirements: REQS,
    tagsByFile: new Map([['a.test.ts', new Set(['SR-01', 'SR-02', 'SR-04'])]]),
  });
  const v = verdict(report, { uncovered: ['SR-02', 'SR-04'] });
  assert.deepEqual(v.stale, ['SR-02', 'SR-04']);
  assert.deepEqual(v.regressions, []);
  assert.equal(v.ok, true);
});

test('a dangling tag fails even when coverage itself is clean', () => {
  const report = coverage({
    requirements: REQS,
    tagsByFile: new Map([['a.test.ts', new Set(['SR-01', 'SR-02', 'SR-04', 'SR-99'])]]),
  });
  assert.equal(verdict(report, { uncovered: [] }).ok, false);
});

test('a requirement becoming judged clears it from the baseline as covered would', () => {
  const report = coverage({ requirements: REQS, tagsByFile: new Map() });
  assert.deepEqual(verdict(report, { uncovered: ['SR-02', 'SR-03', 'SR-04'] }).stale, ['SR-03']);
});
