import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFile,
  codeProse,
  cssProse,
  markdownAnchors,
  markdownProse,
  pathInSpan,
  resolvePath,
  tally,
  verdict,
  type Finding,
  type Repo,
} from './lib.ts';

const HAZARDS = `# Map

## Layout

- **Two opening views, and they are not interchangeable.** Prose.
- **\`center.ts\` is the pure
  half.** Wrapped bold.
`;

function repoOf(files: Record<string, string>, ignored: string[] = []): Repo {
  const dirs = new Set<string>();
  for (const f of Object.keys(files)) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    files: new Set(Object.keys(files)),
    dirs,
    ignored: (p) => ignored.includes(p),
    anchors: (p) => (p.endsWith('.md') ? markdownAnchors(files[p] ?? '') : new Set()),
  };
}

const REPO = repoOf(
  {
    'AGENTS.md': HAZARDS,
    'docs/agents/map.md': HAZARDS,
    'packages/map/board.ts': '',
    'packages/map/index.ts': '',
    'packages/server/index.ts': '',
    'tools/embed/embed.ts': '',
  },
  ['config.json', 'packages/web/e2e/artifacts/']
);

const check = (file: string, source: string): Finding[] => checkFile({ file, source, repo: REPO });
const rules = (findings: Finding[]): string[] => findings.map((f) => f.rule);

test('prose keeps its offsets, so a finding reports its real line', () => {
  const source = 'const a = 1;\n\n// line three: deliberately\n';
  assert.equal(codeProse(source, 'a.ts').length, source.length);
  assert.deepEqual(
    check('a.ts', source).map((f) => [f.rule, f.line]),
    [['conviction', 3]]
  );
});

test('string, template and regex literals are never read as comments', () => {
  const source = [
    "const a = 'a // deliberately — quoted';",
    'const b = `tmpl — ${a} // exactly`;',
    'const c = /\\/\\/ really/;',
    'const d = <p>JSX text — really</p>;',
  ].join('\n');
  assert.deepEqual(check('a.tsx', source), []);
});

test('comment delimiters and block-comment stars are blanked', () => {
  const prose = codeProse('/**\n * one\n */\n/// two\nx(); // three\n', 'a.ts');
  assert.equal(prose.replace(/\s+/g, ' ').trim(), 'one two three');
});

test('a stylesheet contributes its comments and not its strings', () => {
  const prose = cssProse('a::after { content: "/* — */"; } /* note */\n');
  assert.equal(prose.trim(), 'note');
});

test('markdown code fences are not prose', () => {
  const prose = markdownProse('Text.\n\n```sh\nreally —\n```\n\nMore.\n');
  assert.equal(prose.replace(/\s+/g, ' ').trim(), 'Text. More.');
});

test('em dashes fail in comments and markdown', () => {
  assert.deepEqual(rules(check('a.ts', '// one — two\n')), ['em-dash']);
  assert.deepEqual(rules(check('a.md', 'One — two.\n')), ['em-dash']);
  assert.deepEqual(rules(check('a.css', '/* one — two */\n')), ['em-dash']);
});

test('conviction words fail, case-insensitively and across a line wrap', () => {
  assert.deepEqual(rules(check('a.ts', '// Exactly one.\n')), ['conviction']);
  assert.deepEqual(rules(check('a.ts', '// This is the whole\n// reason it exists.\n')), ['conviction']);
});

test('a quoted word is a mention, not a use, and a code span is code', () => {
  assert.deepEqual(check('a.md', 'No conviction words: "exactly", "on purpose".\n'), []);
  assert.deepEqual(check('a.ts', '// see `exactlyOne()`\n'), []);
});

test('a word inside a longer word does not match', () => {
  assert.deepEqual(check('a.ts', '// inexactly, reallyish\n'), []);
});

test('ghost words warn', () => {
  assert.deepEqual(rules(check('a.ts', '// This no longer runs.\n')), ['ghost']);
});

test('a pattern never runs from one comment into the next across code', () => {
  assert.deepEqual(check('a.ts', '// the whole\nfoo();\n// reason\n'), []);
});

test('a citation resolves against headings and bold lead phrases', () => {
  assert.deepEqual(check('a.ts', '// see AGENTS.md, "Layout"\n'), []);
  assert.deepEqual(check('a.ts', '// see `AGENTS.md`\'s "Layout"\n'), []);
  assert.deepEqual(check('a.ts', '// docs/agents/map.md, "Two opening views"\n'), []);
  assert.deepEqual(check('a.ts', '// docs/agents/map.md, "center.ts is the pure half"\n'), []);
});

test('a citation may wrap across comment lines', () => {
  assert.deepEqual(check('a.ts', '// (docs/agents/map.md, "Two opening\n// views")\n'), []);
});

test('a citation to a missing heading or file fails', () => {
  const missing = check('a.ts', '// docs/agents/map.md, "Two starting views"\n');
  assert.deepEqual(rules(missing), ['pointer']);
  assert.match(missing[0].message, /no heading or bold phrase "Two starting views"/);
  assert.deepEqual(rules(check('a.ts', '// docs/gone.md, "Layout"\n')), ['pointer']);
});

test('a prefix citation must end on a word boundary', () => {
  assert.deepEqual(rules(check('a.ts', '// docs/agents/map.md, "Two open"\n')), ['pointer']);
});

test('a bare markdown name resolves relative to the citing file', () => {
  assert.deepEqual(check('docs/agents/other.md', 'See `map.md`, "Layout".\n'), []);
});

test('backticked paths must exist', () => {
  assert.deepEqual(check('a.ts', '// see `tools/embed/embed.ts` and `tools/embed/`\n'), []);
  assert.deepEqual(rules(check('a.ts', '// see `tools/embed/gone.ts`\n')), ['pointer']);
});

test('a bare filename resolves by its unique suffix, and several matches are unchecked', () => {
  assert.equal(resolvePath('board.ts', 'x/y.ts', REPO), 'packages/map/board.ts');
  assert.equal(resolvePath('index.ts', 'x/y.ts', REPO), 'unchecked');
  assert.equal(resolvePath('gone.ts', 'x/y.ts', REPO), null);
});

test('a gitignored path is unchecked, not missing', () => {
  assert.equal(resolvePath('config.json', 'a.ts', REPO), 'unchecked');
  assert.equal(resolvePath('packages/web/e2e/artifacts/', 'a.ts', REPO), 'unchecked');
});

test('spans that are code, refs, routes or patterns are not paths', () => {
  for (const span of ['origin/main', '/robots.txt', '@scope/pkg', './port.ts', '.e2e.ts', '*.test.ts', '{name}.test.ts', 'a / b', 'summary.json'])
    assert.equal(pathInSpan(span, REPO), null, span);
  for (const span of ['board.ts', 'docs/api.md', 'tools/embed', 'packages/map/'])
    assert.equal(pathInSpan(span, REPO), span, span);
});

test('markdown links resolve relative to the file, with their anchors', () => {
  assert.deepEqual(check('docs/x.md', '[map](agents/map.md#layout) [top](../AGENTS.md)\n'), []);
  assert.deepEqual(rules(check('docs/x.md', '[map](agents/map.md#nowhere)\n')), ['pointer']);
  assert.deepEqual(rules(check('docs/x.md', '[gone](gone.md)\n')), ['pointer']);
  assert.deepEqual(check('docs/x.md', '[web](https://example.com/x.md) [here](#top)\n'), []);
});

test('a closed issue citation warns only when the closed set is known', () => {
  const source = '// see #12 and #34, not #fff or a#56\n';
  assert.deepEqual(checkFile({ file: 'a.ts', source, repo: REPO }), []);
  const found = checkFile({ file: 'a.ts', source, repo: REPO, closedIssues: new Set([12, 56]) });
  assert.deepEqual(found.map((f) => f.match), ['#12']);
});

test('the baseline counts only failing rules', () => {
  const counts = tally(new Map([['a.ts', check('a.ts', '// exactly, no longer, really —\n')]]));
  assert.deepEqual(counts, { 'a.ts': { conviction: 2, 'em-dash': 1 } });
});

test('the verdict fails above the baseline and reports below it', () => {
  const result = verdict({ 'a.ts': { conviction: 2 }, 'b.ts': { pointer: 1 } }, { 'a.ts': { conviction: 1 }, 'b.ts': { pointer: 2 } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.regressions, [{ file: 'a.ts', rule: 'conviction', count: 2, allowed: 1 }]);
  assert.deepEqual(result.stale, [{ file: 'b.ts', rule: 'pointer', count: 1, allowed: 2 }]);
  assert.equal(verdict({}, { 'a.ts': { pointer: 1 } }).ok, true);
});
