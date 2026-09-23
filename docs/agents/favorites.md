# Favorites

Hazards for coding agents working on favorites: the server store, client
identity, sorting and the on-map badge. `AGENTS.md`'s "Things that will bite
you" routes here, and its conventions still apply.

## Favorites

- **A count is a set's size, never a counter.** `packages/server/favorites.ts`
  stores, per room, a set of `HMAC(salt, file + NUL + clientId)`. Adding
  twice is one favorite and removing what was never there is nothing, so no
  request can zero a room or run it up. Replacing the set with an increment
  loses that.
- **The hash is per room.** One visitor hashes differently in every room's
  set, so sets cannot be joined into one person's list, and the store cannot
  count distinct visitors. That is intended. Hashing de-duplicates; it is not
  a security control.
- **Identity is a client-generated token, not `req.ip`.** The browser mints
  a random id once (`persist.ts`'s `getOrCreateFavoriteClientId`) and sends
  it as `X-Favorite-Client`; `app.ts` rejects one that fails
  `CLIENT_ID_PATTERN`. Addresses collide real visitors behind NAT and split
  one visitor across rotating IPs. A regenerated token only reverts a
  visitor to "not yet favorited"; the set semantics are what stop abuse.
- **Favorites are keyed by filename everywhere** - server, `localStorage`,
  and `packages/map/favorites.ts`. Room ids are positional (`scan.ts` sorts
  filenames), so adding one image renumbers every later id, and a stored id
  would silently point at a different room.
- **Favorite writes are rate-limited by `req.ip`**, a different key than
  identity, because a script can mint a fresh token per request for free
  (`app.ts`'s `createRateBuckets`). Behind a reverse proxy, `req.ip` is the
  proxy, so without `--trust-proxy` every visitor shares one bucket. The flag
  stays off by default: trusting `X-Forwarded-For` where nothing strips it
  lets a client choose its own rate budget. The proxy must send
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.
- **No store, no feature.** Without `--favorites` the routes are not mounted
  and `manifest.favorites` is null, which every consumer reads as "render no
  favorite control" - distinct from a count of zero.
- **A relevance sort is a re-rank, and the catalog row's toggle is in the
  head.**
  - In `'relevance'` mode, sorting swaps `order` (the reorder animation's
    path) and never rebuilds the layout. A favorite sort is a placement
    input; see `map.md`, "Only four things recompute placement".
  - A catalog row is a fixed height, so its favorite control sits beside
    "show on the map", not inside `RoomDetails` as on the card and overlay.
    In the text column it would cost two story lines on every row.
- **The on-map badge is the third favorite control, and it is fixed art,
  not a scanned corpus asset.** `assets/fav_on.png`/`fav_off.png`
  (`tiles.ts`'s `FAV_ON`/`FAV_OFF`) resolve off `manifest.sharedBase`
  directly; `scan.ts` discovers only their scaled pyramid
  (`shared.favoriteLevels`). The renderers draw it on every non-center,
  non-generic cell; `favoriteBadge.ts` is the pure geometry and hit-test
  half. Two separate zoom gates:
  - **Drawing needs an exact pyramid level.** The scaled art is hand-tuned
    and stops at tile width 128. `drawFavoriteBadge`/`drawFavoriteBadgeGL`
    skip the cache's coarser-or-finer substitution: the badge's screen size
    tracks the tile regardless of which rung backs it, so a substitute
    would only be blurrier.
  - **Interaction needs `config.favorites.minInteractiveTileWidth`.** The
    tap handler (`main.tsx`) and hover path (`useMapRenderer.ts`,
    `useMapRendererGL.ts`) check it before hit-testing `favoriteHitRect`,
    which is padded to `MIN_FAVORITE_HIT_TOUCH` on a coarse pointer.
