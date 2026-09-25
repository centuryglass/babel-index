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
 *
 * `LOG_FILE`, if set, also writes every line to that path through
 * `log-file.ts`'s size-capped rotating destination (`LOG_FILE_MAX_BYTES`,
 * default `DEFAULT_LOG_FILE_MAX_BYTES`) - what `app.ts`'s log routes read
 * back (see its `logFile` option). Pretty printing is skipped whenever
 * `LOG_FILE` is set: the deploy is the only place it is expected, and
 * stdout there is never a TTY, so an interactive terminal with `LOG_FILE`
 * set gets plain JSON.
 */
import pino from 'pino';
import { createRotatingFileStream, DEFAULT_LOG_FILE_MAX_BYTES } from './log-file.ts';

/**
 * `pino-pretty` is a devDependency, so a production install
 * (`npm ci --omit=dev`) may not have it. Resolution is checked rather than
 * the package required: a TTY with no pretty package installed degrades to
 * plain JSON, not a crash on the first log call.
 */
function prettyPrinterAvailable(): boolean {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const logFilePath = process.env.LOG_FILE;

export const logger = logFilePath
  ? pino(
      { level: process.env.LOG_LEVEL ?? 'info', serializers: { err: pino.stdSerializers.err } },
      pino.multistream([
        { stream: process.stdout },
        { stream: createRotatingFileStream(logFilePath, Number(process.env.LOG_FILE_MAX_BYTES) || DEFAULT_LOG_FILE_MAX_BYTES) },
      ])
    )
  : pino({
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: { err: pino.stdSerializers.err },
      transport:
        process.stdout.isTTY && prettyPrinterAvailable()
          ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } }
          : undefined,
    });
