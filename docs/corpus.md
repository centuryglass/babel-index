# Corpus format

A corpus is a directory of room images plus two optional JSON sidecars:
`metadata.json` for each room's text, and `tagLinks.json` for keyword links.
`npm run demo -- --images <dir>` serves any such directory, and
[`assets/corpus-sample/`](../assets/corpus-sample) is a complete example.

```text
<dir>/
  001.webp  002.webp  ...   room images: .jpg, .jpeg, .png or .webp
  metadata.json             optional, per-room text
  tagLinks.json             optional, keyword -> url
  embeddings.bin/.json      optional, written by `npm run generate:embeddings`
```

The generators that fill the rest of the directory (the resolution pyramid,
CLIP embeddings) are in [`README.md`](../README.md)'s "Your own rooms".
[`tools/curation/`](../tools/curation/README.md) holds the tools that
produce `metadata.json`.

## Rooms and their ids

Every image in the directory is a room. A room's id is its position in the
sorted filename list, so adding or removing one image renumbers every room
after it. Anything that has to survive a corpus change is therefore keyed by
filename, never by id:

- `metadata.json` entries;
- favorites, on the server and in the browser;
- permalinks (`catalog/<slug>`), which use the title or the filename stem.

`embeddings.bin` is the exception: its rows follow id order, so it must be
regenerated whenever the set of images changes. The server ignores a blob
whose row count no longer matches the corpus, and search falls back to
keywords and story.

## `metadata.json`

One object, keyed by image filename. Each value describes that room:

```json
{
  "001.webp": {
    "title": "Unparsed Light",
    "keywords": [
      { "text": "Alfred Richard Gurrey", "type": "artist" },
      { "text": "outsider art", "type": "movement/style" },
      { "text": "databending", "type": "technique/process" }
    ],
    "story": "The green smear across the walls happens whenever...",
    "alt": "Glitch art with heavy horizontal databending artifacts...",
    "sensitive_content_tags": []
  }
}
```

The whole file is optional, and so is every field in it. A room with no
entry, or an entry with none of `title`, `keywords`, `story` or `alt`, shows
its image only, and search can reach it through CLIP alone. Fields the app
does not know are ignored, which is how the curation fields below coexist
with it.

At startup the server logs how many entries matched a room. If none did, it
warns that the keys are probably not the image filenames.

### Fields the app reads

| Field | Type | Used for |
| --- | --- | --- |
| `title` | string | The room's name in the catalog, its overlay and its permalink. Also the catalog's alphabetical sort key, and the title signal in search. |
| `keywords` | array of `{text, type}` | Keyword chips, and the keyword signal in search. |
| `story` | string | The overlay and, space permitting, the catalog row. Also the story signal in search. |
| `alt` | string | The room image's `alt` text. |
| `sensitive_content_tags` | array of strings | Tags a reader can choose to block. |

- **`title`** should be unique across the corpus. A room without one is
  called "Room {id}" and its permalink is its filename stem. Two rooms with
  the same title both stay reachable: each permalink gets its filename stem
  as a suffix, and the server logs a warning at startup. The same happens
  when a title slugs to another room's filename stem.
- **`keywords`** are the style keywords the image was generated from, one
  `{text, type}` object each.
  - `text` is the keyword itself. Clicking a chip searches for it.
  - `type` is a category label, such as `artist` or `medium/material`. The
    app shows it only in the chip's hover tooltip; search ignores it.
  - The corpus convention is three keywords per room. Nothing enforces the
    count, but other counts are largely untested.
- **`story`** is a short piece of fiction about the room, usually one or two
  paragraphs. The overlay keeps its line breaks.
- **`alt`** describes the picture for a reader who cannot see it. It is an
  image caption, not a story: it never feeds search. It is AI-generated and
  human-reviewed, written offline alongside the story. The app treats it as
  optional: without it the client's `<img>` gets an empty `alt`, and the
  server-rendered catalog pages use the title. Every room in the live corpus
  has one.
- **`sensitive_content_tags`** lists the kinds of image or story content in
  the room that a reader might want to hide. The app has no fixed
  vocabulary: the block list in the help dialog offers every tag present in
  the corpus, and shows nothing when there are none. A missing key and an
  empty array mean the same thing, no known sensitive content.

### Fields for curation tools

The app never reads these. They are written and read by the offline tools,
and every one is optional.

| Field | Type | Meaning |
| --- | --- | --- |
| `hash` | string | Content hash of the source image, written by `npm run generate:mips`. It lets two copies of `metadata.json` be diffed to see which images changed. `tools/upload` does not use it. |
| `final` | boolean | The story is approved. Title generation and sensitive-content tagging only consider final rooms by default, and the review tools skip them. |
| `needs_inpainting` | `true`, or absent | The image has a flaw awaiting a fix in the inpainting pipeline. |

## `tagLinks.json`

A flat object mapping keyword `text` to a url, hand-edited:

```json
{
  "outsider art": "https://en.wikipedia.org/wiki/Outsider_art",
  "databending": "https://en.wikipedia.org/wiki/Databending"
}
```

A keyword chip whose text has an entry gets a "more about this" link. The
match is on the exact keyword text, and nothing checks that a key is used by
any room. Without the file, chips have no links and nothing else changes.
