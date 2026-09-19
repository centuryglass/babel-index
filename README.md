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

This repository has two audiences, and both are real.

It is **an art piece**: a love letter to the work of exploring and curating the
infinite variation found in generative imagery. The search is depicted as a
vast library, where you can explore thousands of hand-picked variant shelves,
each with its own story. To help in the hunt, you can rearrange the shelves,
searching based on image content, tags used for image generation, and story
text. You can tag your favorites, and view the ones that other people liked
the most.

It is also **a working, deployed web application**, maintained as the kind of
thing an engineer would want to be judged on: a required CI gate across Node
20/22/24, a deploy that refuses to call a failed restart a success, and a unit
suite covering the placement, ranking, and animation logic without booting a
browser. If that's what you're here for, skip to
[**How it's built**](#how-its-built) or read
[`docs/architecture.md`](docs/architecture.md) for the five-minute version.

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

The main interface is a gigantic map of that library. Most shelves are still
the same meaningless shelves from the Borges story, but scattered among them
are 2048 unique shelves, each an AI-generated art piece with its own story.
I've exhaustively curated and refined both the images and stories, ensuring
all of them are at least somewhat interesting.

> TODO: showcase screenshots wanted here - the map at browsing zoom, distill
> mode with the filler shelves banished, and an unannotated room overlay. All
> three need to come off the live deployment; the sample corpus in this repo
> is too small to render any of them well.

## Search, and the density gradient

| ![A search for "plants" pulls many close matches toward the center](docs/images/search_plants.jpg) | ![A search for "sociology" pulls only a few unique rooms toward the center](docs/images/search_sociology.jpg) |
| --- | --- |
| A search for "plants" finds many close matches and pulls them close to the center. | A search for "sociology" finds few close matches, so only a few unique rooms are drawn towards the center. |

A search does not just re-rank the library; it changes the library's shape.
Rooms the search is confident about are pulled toward the center, and the
generic filler shelves around them are thinned out in proportion to that
confidence. A query the library can answer clusters tightly. A query it
cannot stays diffuse. The map tells you how much to trust the result before
you have read a single room.

That works because ranking and certainty are two separate measurements.
Ranking blends three signals - CLIP image embeddings, keyword
matches, and story text - normalized and min-maxed across the corpus for that
query, so some room always scores 1.00 no matter what you typed. Certainty
reads raw cosine distances against absolute bounds calibrated from a real
corpus, so nonsense scores near zero and the gradient stays flat. Driving the
scatter off the ranking number instead would cluster gibberish as confidently
as an exact match.

[`docs/search_rules.md`](docs/search_rules.md) is the full specification;
[`packages/map/scoring.ts`](packages/map/scoring.ts) and
[`packages/map/ordering.ts`](packages/map/ordering.ts) are the implementation.

## The Catalog

Not everyone wants to fly around a map. The catalog is a second reading of
the same corpus: a conventional search box and a paged, ranked list of every
unique room.

![The catalog view: a search bar, the index shelf's contents as a row of
tag/history chips, and a paged, ranked list of rooms](docs/images/catalog.jpg)

It is not the accessibility mode - the map itself is keyboard-navigable and
screen-reader annotated. A linear list was rejected as an accommodation and
kept as a control for everyone.

## Rooms and stories

Every unique room has a title, three style tags, a short story, and a place
on the map. Right-click a room (or long-press on mobile) to read it, along
with a breakdown of why the active search ranked it where it did.

Rooms were generated with Stable Diffusion, using ControlNet to anchor every
one of them to the structure of a base room modeled and rendered in Blender
([reference render](reference/blender/base_render.png)). Stories were written
by various LLMs from the image and its tags, then curated by hand. The images,
keywords, and stories are all public domain.

The open book at the center of the index shelf holds the project's own story
and my artist's statement:

![The project's story on the left page, the artist's statement on the right](docs/images/story_and_statement.jpg)

> The full walkthrough of every control - the index shelf's twelve, the room
> overlay's eight - is in [`docs/user-guide.md`](docs/user-guide.md), or in
> the app's own "READ ME" book.

## How it's built

One Node/Express process serves the API and the client. No database, no
framework server, no build step, seven runtime dependencies.
[`docs/architecture.md`](docs/architecture.md) is the five-minute overview;
these are the parts worth a look.

**No compiled output ever hits disk.** `packages/server/index.ts` starts an
esbuild context in-process at startup and serves the client bundle from
memory, and [`build/`](build)'s Node ESM loader hook runs every `.ts`/`.tsx`
file through esbuild's `transform` per module, in memory, on import. The whole
tree runs as TypeScript on the Node 20 floor with no `dist/` to keep in sync
and no separate build phase to break.

**A 200 is not a successful deploy.** An old process surviving a failed
restart, a unit file pointing at a second checkout, or `--images` aimed at a
directory that moved will all answer a health check looking perfectly
healthy. So `/api/health` reports the git commit the running process actually
loaded, and [`deploy/health-check.mjs`](deploy/health-check.mjs) polls until
that matches the sha being shipped - once from the box itself ("did the unit
come back on the new code?") and again from the public URL ("can anyone reach
it?"). A release that comes up on the right commit with zero rooms fails
immediately instead of waiting out the timeout. The deploy key is an SSH
forced command pinned to [`deploy/deploy.sh`](deploy/deploy.sh), which refuses
any sha that is not already an ancestor of `origin/main` - so the credential
can redeploy or roll back, never run arbitrary code.

**Re-sorting the map is a sliding-tile illusion, not a relayout.**
[`packages/map/illusion.ts`](packages/map/illusion.ts) plans the rearrangement
as whole-row and whole-column rotations bounded to the viewport plus one cell;
everything outside that region is an invisible swap. Visible cost is the
viewport's, not the corpus's. The plan is built and every tile it will reveal
is prefetched before the camera starts moving, with a timeout that falls back
to an instant rebuild rather than blocking on a slow network.

**Favorites store a set, never a counter.**
[`packages/server/favorites.ts`](packages/server/favorites.ts) keeps, per room,
a set of HMACs of a random token the browser mints for itself. Favoriting
twice is one favorite and un-favoriting what was never there is nothing, so no
endpoint can zero a room out or run it up. The hash is per room, so the sets
cannot be joined back into one person's list - the store cannot count distinct
visitors, which is not a thing it should be able to do. Rate limiting is keyed
on the request address, a different key than identity for a reason: a script
can mint a fresh token for free, but an address costs something to change.

**Two renderers, kept in lockstep by hand.** The map is a virtualized canvas
with a Canvas2D implementation and a WebGL2 one (the default where supported),
written as two independent draw loops rather than one abstraction over both.
`npm run test:parity` boots a session of each on a real GPU and compares what
they drew - a manual check, not a merge gate, run when either loop changes.

**The checks that gate a merge.** `npm test` runs the pure logic in
`packages/map`, `packages/config`, `packages/pipeline` and most of the server -
several hundred assertions, no browser, no network. A Playwright suite runs as
a required check alongside lint, typecheck, and CodeQL. `npm run check:file-map`
fails the build when [`docs/file_map.md`](docs/file_map.md) and the real tree
disagree, so the map cannot quietly rot. PR titles are linted for Conventional
Commits format, because this repo squash-merges and the title is the only line
release-please reads.

## Project structure

| | |
| --- | --- |
| `build/` | the Node-side TypeScript hook (`--import ./build/register.mjs`) that lets every script run `.ts` sources directly, no compile step |
| `packages/server/` | offline demo server: scans a directory, serves a manifest |
| `packages/web/` | React + canvas map — pan, zoom, search, live layout controls |
| `packages/map/` | placement, ranking, scoring, the rearrangement animation — no DOM |
| `packages/config/` | the by-feel numbers, with the reasoning behind each |
| `packages/pipeline/` | the resolution-pyramid generator |
| `deploy/` | the VPS deploy script, its SSH forced command, and the health check both halves of the pipeline share |
| `infra/` | Terraform for the Cloudflare R2 bucket the corpus lives in |
| `tools/center-placement/` | tile geometry and the SVG importer |
| `tools/embed/` | computes and stores CLIP image embeddings for a corpus |
| `tools/upload/` | syncs a corpus to Cloudflare R2, incrementally by content hash |
| `tools/font-lab/` | ad hoc design lab for the center shelf's spine titles (not wired into any npm script) |
| `tools/curation/` | Python/Qt tools for turning generated tiles into `metadata.json` — a separate ecosystem, with its own `README.md` |
| `assets/corpus-sample/` | a ready-to-run sample corpus |

> See [`docs/architecture.md`](docs/architecture.md) for a five-minute
> system overview, or [`docs/file_map.md`](docs/file_map.md) for the full
> file-by-file layout.

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

The base demo uses a tiny set of sample images included with this repo. To run
it against a larger set of image tiles:

```sh
npm run demo -- --images /path/to/rooms [--port 5173]
```

To record global favorite counts, point it at a file to keep them in:

```sh
npm run demo -- --favorites path/to/favorites.json [--trust-proxy 1]
```

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

### Running it with Docker

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

### Configuration

Values that can be adjusted to taste (zoom range, opening camera, slider
defaults, search weights, etc.) are in
[`packages/config/config.ts`](packages/config/config.ts), each with its
reasoning. Override any subset with a `config.json`:

```sh
npm run demo -- --config path/to/config.json     # defaults to ./config.json
```

### Testing

```sh
npm test              # node --test, no browser and no network
npm run test:e2e      # browser smoke test (npx playwright install chromium once)
npm run lint
npm run typecheck
npm run check:file-map
```

CI runs the unit tests on Node 20/22/24 and calls the e2e suite; the aggregate
`ci` check needs both, and it gates merges. `npm run test:parity` is a
separate, manual Canvas2D-vs-WebGL render comparison that needs a real GPU and
is not part of CI.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — a five-minute system overview: request flow, deploy, rendering, testing
- [`docs/user-guide.md`](docs/user-guide.md) — every control in the library, annotated
- [`docs/api.md`](docs/api.md) — the `/api/*` request/response contract
- [`docs/file_map.md`](docs/file_map.md) — the full file-by-file layout
- [`docs/concept.md`](docs/concept.md) — the initial project concept and a dated log of design decisions
- [`docs/pending_task_list.md`](docs/pending_task_list.md) — what is still to do
- [`docs/accessibility-plan.md`](docs/accessibility-plan.md) — the keyboard / screen-reader plan
- [`docs/keyboard-controls.md`](docs/keyboard-controls.md) — the full keyboard spec for the map view
- [`docs/search_rules.md`](docs/search_rules.md) — the full specification of what a search does
- [`deploy/README.md`](deploy/README.md) — the one-time VPS setup and the rollback path
- [`CLAUDE.md`](CLAUDE.md) — notes for coding agents (engineering conventions and invariants)

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
