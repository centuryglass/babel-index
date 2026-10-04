# Search fixture

A committed snapshot of the real collection's search inputs, for
`packages/map/scoring.fixture.test.ts`. It is a test fixture, not a
collection: it has no images, and the demo server never loads it.
`tools/search-fixture/fixture.ts`'s header lists the files and their formats.

## Query groups

`queries.json` is hand-edited. Each group makes a promise the tests rely on,
so a query goes in the group whose promise it keeps.

- **`universal`**: something nearly every room shows (a bookshelf). CLIP alone
  should cluster most of the collection.
- **`irrelevant`**: a famous person CLIP recognises whom no room resembles
  and whose name matches no room's text. Nothing should pack at the density
  peak.
  - Objects and scenes do not qualify: the collection's art depicts almost
    anything somewhere (`soccer ball` scores highest on a room with
    ball-like murals). They belong in `concept`.
  - Check a new name's top rooms by eye. About a tenth of rooms show a face
    or figure, and a name resembling one of them is not irrelevant.
- **`keyword`**: a real keyword, as a reader might type it (case and accents
  may differ). At least one room must carry it.
- **`title`**: one room's full title.
- **`story`**: a clause of at least `STORY_LONG_RANGE.high` characters, copied
  verbatim from one room's story.
- **`concept`**: a plain-language query with no known answer. Reported, not
  asserted.
- **`partial`**: a fragment of a title or story too short to count as a
  significant match. Reported, not asserted.

Keysmash queries are left out: CLIP's reading of nonsense text is undefined,
so no answer for them is known.

## Refreshing

```sh
npm run generate:search-fixture                                # after editing queries.json, or changing search's weights or formula
npm run generate:search-fixture -- --tile-collection <dir>     # re-snapshot a collection, then the above
npm run generate:search-fixture -- --check <dir>               # what has drifted since the snapshot; writes nothing
```

- **`report.json` is the review surface.** It summarises every query's
  result, and a test fails when search's output differs from it. A change to
  search regenerates it in the same PR, so the diff shows what the change did
  to real queries.
- **The snapshot does not follow the collection.** Tests assert against what
  is committed here, so a newer collection never breaks them. Re-snapshot when
  `--check` shows enough drift to make the fixture unrepresentative, and
  review the report diff that comes with it.
- **Only new queries need CLIP.** Vectors are reused by query text, so the
  bare command runs without `@huggingface/transformers` unless a query was
  added or the snapshot's model changed.
