# tools/embed — CLIP image embeddings

Runs the CLIP **image** tower over a directory of room images, once, offline,
and writes a static blob the browser ranks against at search time. This is the
pipeline's `embed` stage (see `docs/implementation-plan.md` §4 and Phase 4).

It is Node, not Python: it uses the same `@huggingface/transformers` CLIP model
(`Xenova/clip-vit-base-patch32`) the demo server loads for the **text** tower, so
image vectors and query vectors land in the same space and are directly
comparable. That shared model is the whole reason the ranking means anything —
change it here and you must change it in `packages/server/app.ts`, then
regenerate this blob.

## Run

```sh
node tools/embed/embed.mjs                        # against assets/corpus-sample/
node tools/embed/embed.mjs --images <dir> [--center center.jpg] [--out <dir>]
```

First run downloads the model (cached under `~/.cache/huggingface` afterwards).
Writes two files, next to the images by default:

- `embeddings.bin` — int8, row-major, `count × dim` bytes.
- `embeddings.json` — model, dim, count, scale, the file order, and a
  filename -> content-hash map.

Reruns are incremental: each source file is hashed, and any file whose hash
matches `embeddings.json`'s record from the previous run has its row copied
from the old blob instead of being run back through the vision tower — so
touching a few images in a large corpus costs a few inferences, not the whole
corpus. If nothing changed, the tool doesn't even need
`@huggingface/transformers` installed. Changing `MODEL_ID` invalidates every
cached row, since vectors from different models aren't comparable.

## The one contract that matters

Row order **is** the interface. The file order comes straight from
`scanDirectory()` — the same scan the server assigns room ids from — so row _i_
is room id _i_ by construction, not by a re-implementation that could drift. The
map keys slot placement and `rankByEmbedding()` (`packages/map/ordering.ts`) on
that id, so a wrong order would rank the wrong rooms with no error. Pass the same
`--center` you run the demo server with.

Vectors are L2-normalised and quantised to int8 at scale 127, so an int8 dot
product approximates cosine similarity. Dequantise as `v / 127`.
