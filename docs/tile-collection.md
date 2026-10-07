# Tile collection format

A tile collection is a directory of room images, the shared tiles that fill
the rest of the map, and two optional JSON sidecars: `metadata.json` for each
room's text, and `tagLinks.json` for keyword links. `npm start -- --images <dir>` serves any such directory,
and [`assets/tile-collection-sample/`](../assets/tile-collection-sample) is a
complete example.

```text
<dir>/
  001.webp  002.webp  ...   room images: .jpg, .jpeg, .png or .webp
  metadata.json             optional, per-room text
  tagLinks.json             optional, keyword -> url
  embeddings.bin/.json      optional, written by `npm run generate:embeddings`
  shared/
    center_tile.png         the blank center tile at cell (0, 0), carrying the controls
    generic/                the generic "default" tiles
    generic_distill/        optional, distill mode's alternate per generic tile, by filename stem
```

`shared/` is optional too: without it the map has no center tile and no
generic tiles. Its images are never rooms. The center is `center_tile.*`,
else `center.*`, else the file `--center` names.

The generators that fill the rest of the directory (the resolution pyramid,
CLIP embeddings) are in [`README.md`](../README.md)'s "Your own rooms".
[`tools/curation/`](../tools/curation/README.md) holds the tools that
produce `metadata.json`.

## Rooms and their ids

Every image in the directory is a room. A room's id is its position in the
sorted filename list, so adding or removing one image renumbers every room
after it. Anything that has to survive a collection change is therefore keyed by
filename, never by id:

- `metadata.json` entries;
- favorites, on the server and in the browser;
- permalinks (`catalog/<slug>`), which use the title or the filename stem.

`embeddings.bin` is the exception: its rows follow id order, so it must be
regenerated whenever the set of images changes. The server ignores a blob
whose row count no longer matches the collection, and search falls back to
keywords and story.

## Tile size and shape

The first room with a readable size sets the collection's tile size
(`manifest.tile`), and with it the shape of every cell on the map. Every room
is drawn at that shape, so the rooms should share one aspect ratio. A
collection with no readable image size is refused.

The center tile's traced controls (`shelf_geometry.svg`) are fractions of the
tile, so they fit any size of the shape they were traced at. The server
refuses to start on a collection of another aspect; a new shape needs the
center re-traced and `npm run generate:shelf-geometry` re-run.

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

- **`title`** should be unique across the collection. A room without one is
  called "Room {id}" and its permalink is its filename stem. Two rooms with
  the same title both stay reachable: each permalink gets its filename stem
  as a suffix, and the server logs a warning at startup. The same happens
  when a title slugs to another room's filename stem.
- **`keywords`** are the style keywords the image was generated from, one
  `{text, type}` object each.
  - `text` is the keyword itself. Clicking a chip searches for it.
  - `type` is a category label, such as `artist` or `medium/material`. The
    app shows it only in the chip's hover tooltip; search ignores it.
  - The collection convention is three keywords per room. Nothing enforces the
    count, but other counts are largely untested.
- **`story`** is a short piece of fiction about the room, usually one or two
  paragraphs. The overlay keeps its line breaks.
- **`alt`** describes the picture for a reader who cannot see it. It is an
  image caption, not a story: it never feeds search. It is AI-generated and
  human-reviewed, written offline alongside the story. Every room in the live
  collection has one, so the server logs a warning at startup counting the rooms
  that lack it, including rooms with no entry, and listing the first few by
  filename. A room without one still serves: the client's `<img>` gets an
  empty `alt`, and the server-rendered catalog pages use the title.
- **`sensitive_content_tags`** lists the kinds of image or story content in
  the room that a reader might want to hide. The app has no fixed
  vocabulary: the block list in the help dialog offers every tag present in
  the collection, and shows nothing when there are none. A missing key and an
  empty array mean the same thing, no known sensitive content.

### Fields for curation tools

The app never reads these. They are written and read by the offline tools,
and every one is optional.

| Field | Type | Meaning |
| --- | --- | --- |
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
