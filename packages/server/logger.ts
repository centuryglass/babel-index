/**
 * The one leveled, structured logger every server module writes through.
 *
 * JSON lines when stdout is piped (systemd, CI - anything journald or a log
 * tool parses), pretty-printed when a human is watching a terminal
 * (`npm run demo`). The level and the structured fields are the point:
 * unattributed console output gives nothing to grep for once something has
 * broken and the evidence still matters.
 *
 * `LOG_LEVEL` (default `info`) sets the floor.
 */
import pino from 'pino';

/**
 * `pino-pretty` is a devDependency, so a production install
 * (`npm ci --omit=dev`) may not have it. Resolution is checked rather than
 * the package required: a TTY with no pretty package installed degrades to
 * plain JSON instead of crashing the process on the first log call.
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
