# The Index of Babel

[![ci](https://github.com/centuryglass/babel-index/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/centuryglass/babel-index/actions/workflows/ci.yml)
[![codeql](https://github.com/centuryglass/babel-index/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/centuryglass/babel-index/actions/workflows/codeql.yml)
[![deploy](https://github.com/centuryglass/babel-index/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/centuryglass/babel-index/actions/workflows/deploy.yml)

<!-- Stands in for the social-card unfurl you'd get linking the site directly:
     the same og-image.jpg, title and description index.html's og:*/twitter:*
     meta tags carry. GitHub markdown has no card shorthand, so it is a
     one-column table for the border, with the image width in pixels rather
     than a percentage - a GitHub table sizes to its content, so a percentage
     here has nothing to resolve against. -->

<table>
<tr><td>
<a href="https://centuryglass.us/babel-index/"><img width="900" src="./packages/web/public/og-image.jpg" alt="Rows of lit library shelves, each holding a different generated room, with an open book at the center reading &quot;The Index of Babel&quot;"></a>
</td></tr>
<tr><td>
<sub>CENTURYGLASS.US</sub><br>
<b><a href="https://centuryglass.us/babel-index/">The Index of Babel</a></b><br>
A pannable, zoomable map of AI-generated library rooms, loosely based on the
Library of Babel.
</td></tr>
</table>

This repository has two audiences.

It is **an art piece**: a love letter to the work of exploring and curating the
infinite variation found in generative imagery. The search is depicted as a
vast library, where you can explore thousands of hand-picked variant shelves,
each with its own story. To help in the hunt, you can rearrange the shelves,
searching based on image content, tags used for image generation, and story
text. You can tag your favorites, and view the ones that other people liked
the most.

It is also **a working, deployed web application**, built and maintained as a
real software project, with required CI across Node 20/22/24, unit tests
for the core logic, Playwright browser tests, and automated deployment that
verifies the release it shipped. If that's what you're here for, skip to
[**How it's built**](#how-its-built) or read
[`docs/architecture.md`](docs/architecture.md) for the five-minute version.

This project was coded with significant AI assistance, primarily through
Claude Code and OpenCode. It's become clear over the last few months that
agentic software development is here to stay, and keeping up with the
industry requires adapting to that kind of workflow. This project also serves
as a personal testing-ground for ways to improve agentic workflows and
ensure AI agents reduce technical debt instead of magnifying it.

Content warning: horror, body-horror, death, insects/arthropods, gore, and
trypophobia. Most examples are fairly mild and only present in occasional
rooms. Any of these tags can be blocked with the content settings at the
bottom of the help dialog (the "READ ME" book), or on a first visit with a
URL parameter, e.g. https://centuryglass.us/babel-index/?blockTags=horror,death.
Once a browser has a saved choice, the parameter is ignored.

## The Library

[The Library of Babel](https://en.wikipedia.org/wiki/The_Library_of_Babel)
is a short story by Jorge Luis Borges, published in 1941. This project uses
the library as a metaphor for the exploration of randomness, imagining the
creation of an index that pulls in books from other, more meaningful
hypothetical libraries.

The main interface is a gigantic map of that library. Most shelves are still
the same meaningless shelves from the Borges story, but scattered among them
are 2048 unique shelves, each an AI-generated art piece with its own story.
I've exhaustively curated and refined both the images and stories, ensuring
all of them are at least somewhat interesting.

| ![The map view, a wall of mostly identical bookshelves, with some scattered shelves showing differences.](docs/images/browse.jpg) |
| --------------------------------------------------------------------------------------------------------------------------------- |
| Pan around the map to explore the library and discover unique shelves.                                                            |

| ![An open room overlay, showing a unique room in detail along with story content.](docs/images/room_detail_readme.jpg) |
| ---------------------------------------------------------------------------------------------------------------------- |
| Right-click/tap and hold on any room to see its name, its story, and how closely it matches an active search.          |

| ![A zoomed-out view of many library rooms, all unique, clustered into a circle within a starry void.](docs/images/distill.jpg) |
| ------------------------------------------------------------------------------------------------------------------------------ |
| Activate "distill mode" in the center of the library to banish the identical shelves, pulling in only unique ones.             |

## Search, and the density gradient

| ![A search for "plants" pulls many close matches toward the center](docs/images/search_plants.jpg) | ![A search for "sociology" pulls only a few unique rooms toward the center](docs/images/search_sociology.jpg) |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A search for "plants" finds many close matches and pulls them close to the center.                 | A search for "sociology" finds few close matches, so only a few unique rooms are drawn towards the center.    |

A search does not just re-rank the library; it changes the library's shape.
Rooms the search is confident about are pulled toward the center, and the
generic filler shelves around them are thinned out in proportion to that
confidence. A query the library can answer clusters tightly. A query it
cannot stays diffuse. The map tells you how much to trust the result before
you have read a single room.

Ranking and strength are separate measurements. Ranking blends CLIP image
embeddings, keyword matches and story text into one relative order. Its
CLIP term is min-maxed across the corpus for each query, so some room
always gets full CLIP credit, whatever was searched for.

Strength is absolute. It is a soft-OR of four readings - tag, title, story
and CLIP - each measured against a fixed, corpus-calibrated bound, not
against the other results. A nonsense query scores near zero instead of
producing an artificial "best match", and the density gradient stays flat
when the search has little to say. A corpus with no `embeddings.bin` still
reports strength from its text signals alone.

[`docs/search_rules.md`](docs/search_rules.md) is the full specification;
[`packages/map/scoring.ts`](packages/map/scoring.ts) and
[`packages/map/ordering.ts`](packages/map/ordering.ts) are the implementation.

## The Catalog

Not everyone wants to fly around a map. The catalog is a second reading of
the same corpus: a conventional search box and a paged, ranked list of every
unique room.

![The catalog view: a search bar, the index shelf's contents as a row of
tag/history chips, and a paged, ranked list of rooms](docs/images/catalog.jpg)

It is a choice offered to everyone, not an accessibility mode: the map
itself is keyboard-navigable and screen-reader annotated.

## Rooms and stories

Every unique room has a title, three style tags, a short story, and a place
on the map. Right-click a room (or long-press on mobile) to read it, along
with a breakdown of why the active search ranked it where it did.

Rooms were generated with Stable Diffusion, using ControlNet to anchor every
one of them to the structure of a base room modeled and rendered in Blender
([reference render](reference/blender/base_render.png)). Most rooms were also
edited in [IntraPaint](https://github.com/centuryglass/IntraPaint) to fix
errors and enhance details. Stories were written by various LLMs from the
image and its tags, then curated and edited by hand. The images, keywords,
and stories are all public domain.

The open book at the center of the index shelf holds the project's story
and my artist's statement:

![The project's story on the left page, the artist's statement on the right](docs/images/story_and_statement.jpg)

> Every control on the index shelf and the room overlay is walked through in
> [`docs/user-guide.md`](docs/user-guide.md), and in the app's "READ ME"
> book.

## How it's built

One Node/Express process serves the API, the pages and the client, straight
from TypeScript source: no database, no compile step, and seven runtime
dependencies plus an optional CLIP package.
[`docs/architecture.md`](docs/architecture.md) is the five-minute overview.
The parts most worth a look:

- **Deploys are verified against the running commit.** `/api/health`
  reports the commit the process loaded, and a deploy passes only when that
  matches the sha being released, checked on the box and through the public
  url. A release serving zero rooms fails.
- **Two renderers, one picture.** The map is a virtualized canvas drawn by
  WebGL2 where supported and Canvas2D otherwise. A parity test compares
  them before every deploy.
- **Rearrangement is a sliding-tile illusion.** Only rows and columns on
  screen actually slide; everything else is swapped out of sight, so the
  animation's cost tracks the viewport, not the corpus.
- **Favorites are sets, not counters.** The server keeps a salted hash of a
  random browser-generated id per room, so a repeated favorite or removal
  changes nothing, and no one's personal list can be rebuilt from the
  store.
- **Tests gate merges.** Unit tests on Node 20/22/24, Playwright browser
  tests, lint, typecheck, and the file-map and search-requirements checks
  all feed one required CI check.

## Running it locally

Requires Node 20 or newer.

```sh
npm install
npm run demo        # http://localhost:5173, against assets/corpus-sample/
```

CLIP search needs `@huggingface/transformers`, an optional dependency whose
`onnxruntime-node` ships only for Windows, macOS and Linux. Where it is
missing, the demo still runs and search ranks by keywords and story text
alone.

Every flag is optional:

| Flag                     | Effect                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `--images <dir>`         | serve this directory as the corpus (default `assets/corpus-sample`)                             |
| `--shared-dir <dir>`     | where the center and generic tiles live (default `assets`)                                       |
| `--center <file>`        | name the center tile, if it isn't `center_tile.*` or `center.*`                                  |
| `--port <n>`             | listen port (default 5173); startup fails if it is taken                                        |
| `--config <file>`        | override tuning values (default `./config.json`, if present)                                    |
| `--favorites <file>`     | record global favorite counts in this JSON file; without it, no favorite controls appear        |
| `--trust-proxy <value>`  | Express `trust proxy`; set `1` behind a reverse proxy that sends `X-Forwarded-For`              |
| `--base-path <path>`     | serve under a subpath behind a prefix-stripping proxy, e.g. `/babel-index/`                     |
| `--remote <url> --prefix <name>` | read a corpus uploaded with `npm run upload:r2` instead of `--images`                    |

Behind a reverse proxy, pass `--trust-proxy 1`: favorite writes are
rate-limited by address, and without it every visitor shares the proxy's
address and one rate limit. `--base-path` works only behind such a proxy;
a direct visit to the port serves a page whose requests 404
([`deploy/README.md`](deploy/README.md)). Setting both `LOG_FILE` and
`ADMIN_PASSWORD_HASH` in the environment turns on a password-protected log
viewer at `/admin/logs` ([`docs/api.md`](docs/api.md)).

`npm run demo:watch` rebuilds on every edit and reloads the page; under
plain `npm run demo`, a client edit needs a restart.

### Your own rooms

`--images` takes any directory of room images. Two optional steps make it
look and search like the live site:

```sh
npm run generate:mips -- --images <dir>         # resolution pyramid, so zoomed-out views load fast
npm run generate:embeddings -- --images <dir>   # CLIP embeddings (needs the optional CLIP install)
```

Titles, keywords and stories come from a `metadata.json` beside the
images; [`tools/curation/`](tools/curation/README.md) holds the tools that
produce it.

### Docker

```sh
docker build -t babel-index .
docker run -p 5173:5173 babel-index
docker run -p 5173:5173 -v /path/to/rooms:/data:ro babel-index --images /data
```

Flags go after the image name, as with `npm run demo`. Build with
`--build-arg WITH_CLIP=false` for a smaller image that skips CLIP and ranks
by keywords and story only.

### Configuration

Tunable values (zoom range, opening camera, slider defaults, search
weights, and more) are defined, each with its reasoning, in
[`packages/config/config.ts`](packages/config/config.ts). A `config.json`
passed with `--config` overrides any subset. Invalid values fall back to
defaults, and the server prints a note for each one at startup.

### Testing

```sh
npm test                     # unit tests: node --test, no browser, no network
npm run test:e2e             # Playwright browser tests (run `npx playwright install chromium` once)
npm run test:parity          # Canvas2D vs WebGL render comparison
npm run lint
npm run typecheck
npm run check:file-map       # docs/file_map.md lists every tracked file
npm run check:requirements   # docs/search_requirements.md keeps its test coverage
```

[`docs/architecture.md`](docs/architecture.md#testing-and-ci) lists which of
these gate a merge and which gate a deploy.

## Project structure

|                      |                                                                                   |
| -------------------- | --------------------------------------------------------------------------------- |
| `packages/server/`   | the Express server: API, pages, and the in-memory client bundle                   |
| `packages/web/`      | the React client: the map, its renderers, the catalog, the center-shelf controls  |
| `packages/map/`      | placement, ranking, scoring, and the rearrangement planner; no DOM                |
| `packages/config/`   | the tunable numbers, with the reasoning behind each                               |
| `packages/pipeline/` | the resolution-pyramid generator                                                  |
| `build/`             | the Node loader hook that runs `.ts`/`.tsx` sources directly                      |
| `deploy/`            | the VPS deploy script, its health check, and the nginx config                     |
| `infra/`             | Terraform for the Cloudflare R2 bucket the live corpus is served from             |
| `tools/`             | offline CLIs: embeddings, R2 upload, tile geometry, doc checks, curation (Python) |
| `assets/`            | the sample corpus and the shared center and generic tiles                         |

[`docs/file_map.md`](docs/file_map.md) describes every file.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) - a five-minute system overview: request flow, deploy, rendering, CI
- [`docs/api.md`](docs/api.md) - the `/api/*` request/response contract
- [`docs/user-guide.md`](docs/user-guide.md) - every control in the library, annotated
- [`docs/search_rules.md`](docs/search_rules.md) - what a search does, in full
- [`docs/search_requirements.md`](docs/search_requirements.md) - what search must achieve for a reader, with test coverage tracked per requirement
- [`docs/keyboard-controls.md`](docs/keyboard-controls.md) - the map's keyboard spec
- [`docs/file_map.md`](docs/file_map.md) - every file, and what it is for
- [`docs/concept.md`](docs/concept.md) - the original concept and a dated log of design decisions
- [`deploy/README.md`](deploy/README.md) - one-time VPS setup and rollback
- [`AGENTS.md`](AGENTS.md) - rules for coding agents: conventions and invariants
- [GitHub issues](https://github.com/centuryglass/babel-index/issues) - all open work

## License

This repository - the code, tile geometry, sample corpus, and every document
in it - is released under [the Unlicense](LICENSE): a public-domain
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
