/**
 * Entry point for `--import build/register.mjs`: hooks `.ts`/`.tsx` module
 * loading for the process that imports this. See `ts-loader.mjs` for what
 * the hook actually does.
 */
import { register } from 'node:module';

register('./ts-loader.mjs', import.meta.url);
