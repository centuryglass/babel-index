/**
 * The CLIP text tower for offline tools, loaded the way
 * `packages/server/app.ts` loads it for `/api/search`.
 *
 * `cosine-range.ts` and `tools/search-fixture` both score query strings
 * against a collection's `embeddings.bin`, and a vector embedded through a
 * different path than a live query's measures something else. `embedStrings`
 * matches `app.ts`'s `embedQuery` at its default `clipTextDtype` of `'fp32'`:
 * same tokenizer options, same L2 normalisation.
 */
import { withClipCache } from '../../packages/server/clip-cache.ts';

/**
 * The loaded tokenizer and model.
 *
 * Both members are typed `any`: the package is never imported statically, so
 * there is no type to import either.
 */
export interface TextTower {
  tokenizer: any;
  textModel: any;
}

/**
 * Load the text tower for `model` at fp32.
 *
 * A dynamic import because the package is optional (AGENTS.md,
 * "@huggingface/transformers is optional"). `packages/server/app.ts`'s
 * `hasTextModel()` carries the platform detail. A missing package throws an
 * error tagged `expected`, so a CLI can print its message without a stack.
 */
export async function loadTextTower(model: string): Promise<TextTower> {
  let transformers;
  try {
    transformers = withClipCache(await import('@huggingface/transformers'));
  } catch (err: any) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    throw Object.assign(new Error(
      'This tool needs @huggingface/transformers, which is an optional dependency and is ' +
        'not installed here (it pulls in onnxruntime-node, which does not publish for every ' +
        'platform - see tools/embed/embed.ts). Run this on a machine where it installed.'
    ), { expected: true });
  }
  const { AutoTokenizer, CLIPTextModelWithProjection } = transformers as any;
  const [tokenizer, textModel] = await Promise.all([
    AutoTokenizer.from_pretrained(model),
    CLIPTextModelWithProjection.from_pretrained(model, { dtype: 'fp32' }),
  ]);
  return { tokenizer, textModel };
}

/**
 * L2-normalise one embedded string, the way `embedQuery` (packages/server/app.ts)
 * prepares a live query and `quantiseInto` (tools/embed/embed.ts) an image row.
 */
export function normalise(row: ArrayLike<number>): Float32Array {
  let norm = 0;
  for (let i = 0; i < row.length; i++) norm += row[i] * row[i];
  norm = Math.sqrt(norm) || 1;
  const out = Float32Array.from(row);
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Embed a batch of strings, one L2-normalised query vector per string. */
export async function embedStrings({ tokenizer, textModel }: TextTower, strings: string[]): Promise<Float32Array[]> {
  const inputs = tokenizer(strings, { padding: true, truncation: true });
  const { text_embeds } = await textModel(inputs);
  return text_embeds.tolist().map(normalise);
}
