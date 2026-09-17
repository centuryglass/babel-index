/**
 * Entry point for `--import build/register.mjs`: installs the `.ts`/`.tsx`
 * module-loading hook for the process. `ts-loader.mjs` is the hook itself.
 */
import { register } from 'node:module';

register('./ts-loader.mjs', import.meta.url);
