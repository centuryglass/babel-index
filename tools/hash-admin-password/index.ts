#!/usr/bin/env node
/**
 * Prints an `ADMIN_PASSWORD_HASH` value (packages/server/admin-auth.ts) for
 * the admin log viewer. Setting or rotating the password is: run this, paste
 * the printed hash into the VPS's `/etc/babel-index-deploy.conf` (or
 * wherever `ADMIN_PASSWORD_HASH` is set for the unit - see
 * deploy/README.md), restart the service.
 *
 * The password is read from a hidden terminal prompt, never a CLI argument,
 * so it never lands in shell history or `ps` output, and it is never
 * written to disk anywhere - only the hash is.
 */
import { hashPassword } from '../../packages/server/admin-auth.ts';

const password = await promptHidden('New admin password: ');
if (!password) {
  console.error('password must not be empty');
  process.exit(1);
}
const confirm = await promptHidden('Confirm: ');
if (password !== confirm) {
  console.error('passwords did not match');
  process.exit(1);
}
console.log(hashPassword(password));

/**
 * A prompt whose typed characters are never echoed to the terminal.
 *
 * In raw mode a real terminal delivers one keystroke per `data` event, but
 * that's a property of the terminal, not of the stream - piped input (a
 * test, `printf ... | npm run hash-admin-password`) can deliver a whole
 * line, or more, in one chunk. Walking each chunk a character at a time
 * handles both without assuming which one is talking.
 */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          stdin.setRawMode?.(wasRaw);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input);
          return;
        } else if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(1); // Ctrl+C
        } else if (char === '\u007f' || char === '\b') {
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}
