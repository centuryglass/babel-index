/**
 * pino's numeric level scale, named - the one place `log-reader.ts`'s
 * `minLevel` numbers and `logViewerPage.ts`'s level `<select>` labels come
 * from, rather than two copies of the same six numbers.
 */
export const LOG_LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};
