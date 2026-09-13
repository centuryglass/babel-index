# The Index of Babel

https://centuryglass.us/babel-index/

This project is a love letter to the art of exploring and curating the
infinite variation found in generative imagery. The search is depicted
as a vast library, where you can explore thousands of hand-picked variant
shelves, each with its own story. To help in the hunt, you can rearrange the
shelves, searching based on image content, tags used for image generation, and
story text. You can tag your favorites, and view the ones that other people
liked the most.

Content warning: horror, body-horror, death, insects/arthropods, gore, and
trypophobia. Most examples are fairly mild and only present in occasional
rooms. Any of these tags can be blocked using URL parameters, e.g. 
https://centuryglass.us/babel-index/?blockTags=horror,death or through the
content settings controls at the bottom of the help dialog opened through
the "READ ME" book.

## The Library
[The Library of Babel](https://en.wikipedia.org/wiki/The_Library_of_Babel)
is a short story by Jorge Luis Borges, published in 1941. This project uses
the library as a metaphor for the exploration of randomness, imagining the
creation of an index that pulls in books from other, more meaningful
hypothetical libraries.

## What it is

The main interface is a gigantic map of the Library of Babel. Most shelves are
still the same meaningless shelves from the Borges story, but scattered among
them are 2048 unique shelves, each an AI-generated art piece with its own
story. I've exhaustively curated and refined both the images and stories,
ensuring all of them are at least somewhat interesting.

### The Index Shelf
This center shelf lets you search the library and rearrange its shelves.

./docs/images/center_index.jpg
1. Enter anything into the search bar and the library will rearrange, moving
   rooms so that the closest matches are nearest to the center. Searches will
   match rooms by titles, style tags, story text, and image content.
   
   docs/images/search_plants.jpg
   fig. 1: A search for "plants" finds many close matches and pulls them
           close to the center.
           
   docs/images/search_sociology.jpg
   fig. 2: A search for "sociology" finds few close matches, so only a few
           unique rooms are drawn towards the center.
2. The "READ ME" book opens the help window. The help window describes the
   controls and provides access to content settings controls you can use
   to block rooms that might bother some people.
3. "The Catalog" opens an alternate list interface for viewing library
   shelves, for anyone who'd rather explore this project as a data set
   instead of a fictional space.
4. The remaining books on the shelves hold your search history. If your
   search history doesn't fill the shelf, the remaining books hold a random
   set of tags present within the library. Click any book to repeat the
   search.
5. Clicking the open book in the center will open the project's story and
   my artists' statement. (link to docs/images/story_and_statement.jpg)
6. The bottom-right book will clear your search history.
7. This switch rearranges the library to bring rooms you've marked as
   favorites closest to the center.
8. This switch sorts the library by global favorite counts, bringing the rooms
   that the most people have favorited closest to the center.
9. The shuffle button clears active searches and rearranges the library in a
   new random order.
10. The search button is visible anywhere on the map, and the arrow orbiting
    it always points to the index room. Click it to zoom back to the search
    bar from anywhere on the map.
11. This star is the favorite toggle for the next room to the left. Clicking
    it marks that room as one of your favorites, making it easier for you to
    find again, and adding to the global favorite count. Global favorite data
    is tied to individual browser sessions and is fully anonymized.
12. The distill mode switch banishes all of the near-identical Library of
    Babel shelves from the map, leaving only the unique rooms pulled in by
    the index.
    
### The Map
The map contains every room in the library as a space you can explore.

./docs/images/map.jpg.
(TODO: copy over mouse/touch/keyboard controls from the help window)

### The Catalog
The catalog contains every unique room in the library as a dataset you can
browse.

./docs/images/catalog.jpg
(TODO: do I need to explain any of this? It's all fairly conventional.)
    
### An Example Room
Right clicking a room or long-clicking on mobile will open up a library room's
story and details.

./docs/images/room_details.jpg.
1. Each unique room has its own title.
2. The star icon lets you see how many people have favorited this room, and
   lets you add or remove it from your own list of favorite rooms.
3. The room image, as you'd see it on the map. Rooms were generated using
   Stable Diffusion, using ControlNet to anchor them to the same structure as
   an initial room I modeled and rendered in Blender. (link: reference/blender/base_render.png).
   Feel free to right-click and save rooms and do whatever you'd like with
   them, they're all public domain images.
4. Each room was generated using three style tags. Style tags include artists,
   art styles, materials, LoRA models, and all kinds of other things used to
   affect the style of the generated rooms. Click any tag to search the
   library for other rooms matching that tag. Click the arrow on the right
   side of the tag to open an external site where you can learn more about it.
5. Each library room contains a very short story telling you something about
   the fictional world that particular shelf came from. Stories were written
   by various LLMs based on the image and tags.
6. When a search is active, this block will tell you how closely this room
   matches the search term, breaking down exactly what elements are matched.
7. Click this button to find this room within the catalog mode. If you're
   already in catalog mode, it's replaced by a "show on the map" button. 
8. Clicking here, clicking outside of the frame, or pressing escape closes the
   overlay.

## Project structure

| | |
| --- | --- |
| `build/` | the Node-side TypeScript hook (`--import ./build/register.mjs`) that lets every script run `.ts` sources directly, no compile step |
| `packages/server/` | offline demo server: scans a directory, serves a manifest |
| `packages/web/` | React + canvas map — pan, zoom, search, live layout controls |
| `packages/map/` | placement, ranking, scoring, the rearrangement animation — no DOM |
| `packages/config/` | the by-feel numbers, with the reasoning behind each |
| `packages/pipeline/` | the resolution-pyramid generator |
| `tools/center-placement/` | tile geometry and the SVG importer |
| `tools/embed/` | computes and stores CLIP image embeddings for a corpus |
| `tools/upload/` | syncs a corpus to Cloudflare R2, incrementally by content hash |
| `tools/font-lab/` | ad hoc design lab for the center shelf's spine titles (not wired into any npm script) |
| `tools/curation/` | Python/Qt tools for turning generated tiles into `metadata.json` — a separate ecosystem, with its own `README.md` |
| `assets/corpus-sample/` | a ready-to-run sample corpus |

> See [`CLAUDE.md`](CLAUDE.md) for the full file-by-file layout.

## Running it locally

Requires Node 20 or newer (CI runs 20/22/24).

```sh
npm install
npm run demo        # http://localhost:5173, against assets/corpus-sample/
```

CLIP-based search (`@huggingface/transformers`, via `onnxruntime-node`) is
optional: it only supports win32/darwin/linux, so nothing else in the demo
requires it, and it's never imported statically. Without it, search still
works from keyword and story matching alone, just without the embedding
signal.

The base demo uses a tiny set of sample images included with this repo. To run it against a larger set of image tiles:

```sh
npm run demo -- --images /path/to/rooms [--port 5173]
```

To record global favorite counts, point it at a file to keep them in:

```sh
npm run demo -- --favorites path/to/favorites.json [--trust-proxy 1]
```

## Running it with Docker

```sh
docker build -t babel-index .
docker run -p 5173:5173 babel-index
```

Against your own image tiles instead of the sample corpus, mount them and pass
`--images` the same way you would to `npm run demo`:

```sh
docker run -p 5173:5173 -v /path/to/rooms:/data:ro babel-index --images /data
```

Any flag from above works the same way, appended after the image name (they
replace the default `CMD`, not the entrypoint). Pass `--build-arg
WITH_CLIP=false` for a smaller image that skips the CLIP text tower and ranks
by keywords and story only - the container equivalent of the lighter install
above.

Without it, no counts are recorded and no favorite control appears - the
server stays stateless, which is what the demo has always been. What is stored
is, per room, a set of salted hashes of a random id the browser generates for
itself: enough to keep one visitor from favoriting the same room twice, and
not enough to reconstruct anyone's list. Personal favorites are never sent
anywhere; they live in the browser, like the search history.

`--trust-proxy` is needed behind a reverse proxy (it is Express's own
`trust proxy` setting, verbatim), or every visitor arrives as the proxy's own
address for rate-limiting purposes, and one visitor hammering the favorite
endpoint can throttle it for everyone behind that proxy. The proxy has to be
sending `X-Forwarded-For` for it to help.

TODO: screenshot of the center room with the search box and book spines


### Configuration
Values that can be adjusted to taste (zoom range, opening camera, slider defaults,
search weights, etc.) are in [`packages/config/config.ts`](packages/config/config.ts),
each with its reasoning. Override any subset with a `config.json`:

```sh
npm run demo -- --config path/to/config.json     # defaults to ./config.json
```

### Testing

```sh
npm test              # node --test, ~1s, no browser and no network
npm run test:e2e      # browser smoke test (npx playwright install chromium once)
```

CI runs `npm test` and the e2e smoke test on Node 20/22/24.

## Screenshots

> TODO: pick the interesting ones.

- TODO: screenshot of a room card (keywords + story)
- TODO: screenshot of the reorder animation mid-slide
- TODO: screenshot of the density gradient after a hazy vs. exact search

## Documentation

- [`docs/concept.md`](docs/concept.md): Initial project concept and a dated log of design decisions
- [`docs/pending_task_list.md`](docs/pending_task_list.md) — what is still to do
- [`docs/accessibility-plan.md`](docs/accessibility-plan.md) — the keyboard / screen-reader plan
- [`docs/keyboard-controls.md`](docs/keyboard-controls.md) — the full keyboard spec for the map view
- [`docs/search_rules.md`](docs/search_rules.md) — the full specification of what a search does
- [`CLAUDE.md`](CLAUDE.md) — notes for coding agents, and the full file-by-file layout

## License

This repository - code, the tile geometry, the sample corpus, and every
document in it - is released under [the Unlicense](LICENSE): a public-domain
dedication with no conditions attached.

The full corpus of generated rooms hosted live at
[centuryglass.us/babel-index](https://centuryglass.us/babel-index/) (images,
keywords, and story text - synced to R2 by `tools/upload`, not checked into
this repo) is dedicated to the public domain under
[CC0](https://creativecommons.org/publicdomain/zero/1.0/).

Both dedications are offered as a matter of clarity rather than an
acknowledgment that copyright otherwise applies: most of this material is
AI-generated, and under current US Copyright Office guidance, purely
AI-generated output with no human authorship is not eligible for copyright
protection in the first place. Where a human edit (retouching an image,
writing or revising a story) might arguably introduce enough authorship to
matter, the Unlicense/CC0 dedication is what removes any doubt.
