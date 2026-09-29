import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleStylesheet, stylesheetImports } from './stylesheet.ts';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../web');

/** A `read` over an in-memory tree rooted at `/web`. */
function fakeFs(files: Record<string, string>) {
  return async (path: string) => {
    if (path in files) return files[path];
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  };
}

test('assembleStylesheet inlines each import line in order and keeps the rest', async () => {
  const read = fakeFs({
    '/web/style.css': '/* header */\n@import "css/a.css";\n@import "css/b.css";\n',
    '/web/css/a.css': '.a { color: red; }\n',
    '/web/css/b.css': '.b { color: blue; }\n.c { url(shared/x.png); }\n',
  });
  assert.equal(
    await assembleStylesheet('/web/style.css', read),
    '/* header */\n.a { color: red; }\n.b { color: blue; }\n.c { url(shared/x.png); }\n'
  );
});

test('assembleStylesheet throws on a missing partial, naming it', async () => {
  const read = fakeFs({ '/web/style.css': '@import "css/gone.css";\n' });
  await assert.rejects(assembleStylesheet('/web/style.css', read), /css\/gone\.css/);
});

test('assembleStylesheet throws on an import inside a partial', async () => {
  const read = fakeFs({
    '/web/style.css': '@import "css/a.css";\n',
    '/web/css/a.css': '.a {}\n@import "b.css";\n',
  });
  await assert.rejects(assembleStylesheet('/web/style.css', read), /css\/a\.css line 2/);
});

test('assembleStylesheet throws on an import written any other way', async () => {
  for (const line of [
    "@import 'css/a.css';",
    '@import url("css/a.css");',
    '@import "css/a.css" screen;',
    '  @import "css/a.css";',
    '@import "css/a.css"',
  ]) {
    const read = fakeFs({ '/web/style.css': `${line}\n`, '/web/css/a.css': '.a {}\n' });
    await assert.rejects(assembleStylesheet('/web/style.css', read), /whole line/, line);
  }
});

test('the real style.css imports every css/*.css partial exactly once', async () => {
  const imports = stylesheetImports(await readFile(join(webDir, 'style.css'), 'utf8'));
  const partials = (await readdir(join(webDir, 'css'))).filter((f) => f.endsWith('.css'));
  assert.deepEqual([...imports].sort(), partials.map((f) => `css/${f}`).sort());
  assert.equal(new Set(imports).size, imports.length, 'a partial is imported twice');
});

test('the real style.css assembles with no import left in it', async () => {
  const css = await assembleStylesheet(join(webDir, 'style.css'));
  assert.doesNotMatch(css, /^\s*@import\b/m);
  assert.match(css, /url\(shared\/leather_texture_tile\.png\)/);
});
