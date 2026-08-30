# babel-index

> TODO: one-line tagline for the project.

## Artist's statement

- Brief description of the concept of the Library of Babel, linking to the
  [original story](https://sites.evergreen.edu/politicalshakespeares/wp-content/uploads/sites/226/2015/12/Borges-The-Library-of-Babel.pdf).
- Tie it back to the concept of divination: all the ways humanity has 
  searched the noise for meaning.
- Connection: No one put meaning in that noise, but it often exists there
  entirely by chance. The odds aren't great, but sometimes the infinite monkeys
  really do give you Shakespeare.
  
Claims:
- The search is *not* futile, we have the technology. Through information and
  computer science we can filter the noise and force it into meaningful shapes.
- The search is still a grind: even when filtered, the vast majority of results
  are insignificant. It is a struggle, but one worth pursuing by those who
  care to try.

Other possible things to tie in:
- My own curation process: These rooms are perhaps the best 5% of the total
  volume I searched. Many of them were individually retouched to correct minor errors
  spoiling an otherwise fascinating result. Stories were similarly filtered and edited.
- Viewing the piece is similar to the process of creating it.

Lingering questions:
- Chaos vs. recombination: The images were seeded with concept-tags, randomly
  recombined, many of which are tied to statistical reconstructions of
  patterns real artists invented deliberately. Is it somehow unfair to the
  legacies it builds on? I would answer no, but should I defend it pre-emptively?
- How much does the filtering actually "spoil" the noise? Am I cutting myself
  off from real revelation by using AI tools that force me into statistical grooves?
  Temperature variation helps, but I'm not sure it helps enough.
- How does aesthetics fit in? I'm not discovering deep truths here, I'm finding patterns
  I think are interesting. Is searching the noise actually practical, or am
  I just entertaining myself with shapes and colors? Does it matter?

## What it is

> TODO: project description. A pannable, zoomable map of AI-generated Library of
> Babel rooms; one tile is one shelved wall (5 shelves × 32 books = 160 books).
> Search re-ranks the whole corpus and the map rearranges around the query.
> The image/inpainting pipeline is out of scope for this repo — what lives here
> is the map, the tile geometry, and an offline demo.

TODO: screenshot of the map zoomed out, showing the density cluster after a search

## Project structure

| | |
| --- | --- |
| `packages/server/` | offline demo server: scans a directory, serves a manifest |
| `packages/web/` | React + canvas map — pan, zoom, search, live layout controls |
| `packages/map/` | placement, ranking, scoring, the rearrangement animation — no DOM |
| `packages/config/` | the by-feel numbers, with the reasoning behind each |
| `packages/pipeline/` | the resolution-pyramid generator |
| `tools/center-placement/` | tile geometry and the SVG importer |
| `assets/corpus-sample/` | a ready-to-run sample corpus |

> TODO: expand if needed. See [`CLAUDE.md`](CLAUDE.md) for the full layout.

## Running it locally

```sh
# For a lighter test build without CLIP or image preprocessing:
# npm install --omit=dev --omit=o
 
# For the full build:
npm install

npm run demo        # http://localhost:5173, against assets/corpus-sample/
```

The base demo uses a tiny set of sample images included with this repo. To run it against a larger set of image tiles:

```sh
npm run demo -- --images /path/to/rooms [--port 5173]
```

To record global favorite counts, point it at a file to keep them in:

```sh
npm run demo -- --favorites path/to/favorites.json [--trust-proxy 1]
```

Without it, no counts are recorded and no favorite control appears - the
server stays stateless, which is what the demo has always been. What is stored
is, per room, a set of salted hashes of the favoriting address: enough to keep
one visitor from favoriting the same room twice, and not enough to reconstruct
anyone's list. Personal favorites are never sent anywhere; they live in the
browser, like the search history.

`--trust-proxy` is needed behind a reverse proxy (it is Express's own
`trust proxy` setting, verbatim), or every visitor arrives as the proxy's own
address and every count stops at one. The proxy has to be sending
`X-Forwarded-For` for it to help.

TODO: screenshot of the center room with the search box and book spines


### Configuration
Values that can be adjusted to taste (zoom range, opening camera, slider defaults,
search weights, etc.) are in [`packages/config/config.ts`](packages/config/config.ts),
each with its reasoning. Override any subset with a `config.json`:

```sh
npm run demo -- --config path/to/config.json     # defaults to ./config.json
```
.

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

- [`concept.md`](concept.md): Initial project concept
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — how it gets there, and what's next
- [`docs/accessibility-plan.md`](docs/accessibility-plan.md) — the keyboard / screen-reader plan
- [`docs/design-history.md`](docs/design-history.md) — decisions reversed and alternatives rejected
- [`docs/borges-parameters.md`](docs/borges-parameters.md) — every number from the story, with its passage
- [`CLAUDE.md`](CLAUDE.md) — notes for coding agents, and the full file-by-file layout

## License

> TODO: choose a license.
