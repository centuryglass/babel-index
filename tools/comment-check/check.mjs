#!/usr/bin/env node
/**
 * Guard a comment-only edit: report whether the working tree differs from the
 * committed version of a file in anything but comments.
 *
 *   node tools/comment-check/check.mjs packages/map/illusion.ts
 *   node tools/comment-check/check.mjs --base HEAD~1 path/a.ts path/b.ts
 *
 * Exit 0 when every file is comment-only (or unchanged); exit 1 with the
 * code-side diff if any file's real code moved. This is the "I didn't touch the
 * code" check every refactor pass runs before committing.
 */
import { strip } from './strip.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let base = 'HEAD';
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base') base = args[++i];
  else files.push(args[i]);
}
if (!files.length) {
  console.error('usage: check.mjs [--base <rev>] <file...>');
  process.exit(2);
}

const gitShow = (rev, file) => execFileSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8', maxBuffer: 1e8 });
const lineDiff = (a, b) => {
  const A = a.split('\n'), B = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] !== B[i]) out.push(`    - ${A[i] ?? ''}\n    + ${B[i] ?? ''}`);
  }
  return out.join('\n');
};

let dirty = 0;
for (const file of files) {
  let before, after;
  try {
    before = gitShow(base, file);
    after = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`  ERROR  ${file}: ${e.message.split('\n')[0]}`);
    dirty++;
    continue;
  }
  if (before === after) {
    console.log(`  clean   ${file} (unchanged)`);
    continue;
  }
  try {
    const sb = strip(before, file);
    const sa = strip(after, file);
    if (sb === sa) {
      console.log(`  OK      ${file} (comment-only)`);
    } else {
      console.log(`  CHANGED ${file} (code differs vs ${base}):`);
      console.log(lineDiff(sb, sa));
      dirty++;
    }
  } catch (e) {
    console.log(`  ERROR   ${file}: ${e.message}`);
    dirty++;
  }
}
process.exit(dirty ? 1 : 0);
