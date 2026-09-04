/**
 * The one leveled logger the server writes through.
 *
 * Before this, startup notes and runtime failures went straight to
 * `console.log`/`warn`/`error` - unattributed lines with no level and no
 * timestamp, indistinguishable from each other once piped into journald. That
 * cost a real incident: a broken CLIP install had nothing to grep for and the
 * evidence was gone by the time anyone went looking. Every such note now goes
 * through `logger` instead, as JSON lines when stdout is piped (systemd, CI -
 * anything journald or a log tool can parse) and pretty-printed when a human
 * is watching a terminal (`npm run demo`).
 *
 * `LOG_LEVEL` (default `info`) sets the floor.
 */
import pino from 'pino';

/**
 * `pino-pretty` is a devDependency - fine for a terminal, but a production
 * install (`npm ci --omit=dev`) may not have it. Checking resolution rather
 * than requiring it directly means a TTY with no pretty package installed
 * degrades to plain JSON instead of crashing the process on the first log
 * call.
 */
function prettyPrinterAvailable(): boolean {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  serializers: { err: pino.stdSerializers.err },
  transport:
    process.stdout.isTTY && prettyPrinterAvailable()
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } }
      : undefined,
});
