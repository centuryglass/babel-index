# What hosting this actually costs

Cloudflare R2 bills **per GET operation, not per byte**. That inverts the usual
instinct, and it puts the resolution pyramid — which exists to cut bytes — on
the wrong side of the meter. Bytes are free on R2; requests are not. So the
question is whether the pyramid, which turns one image per room into five,
multiplies the bill by five.

**It does not.** On a mixed traffic load it costs about **1.6× the operations**
of serving level 0 alone, and at any traffic this project is likely to see, the
bill is **$0.00** either way. The numbers below say why, and where the real
levers are if that ever stops being true.

Everything here is reproducible:

```sh
node tools/cost-model/report.mjs
```

The session counts come from replaying camera paths over the real layout
(`packages/map/ordering.js`) and the real level policy
(`packages/web/src/pyramid.js`), not from estimates. Per-level byte sizes are
measured off the sample corpus at the new 1024×768 tile. Assumptions and their
soft spots are listed at the end — read those before acting on the total.

---

## 1. The shape of the meter

| | R2 |
| --- | --- |
| GET (Class B) | $0.36 per million, **first 10M/month free** |
| Write (Class A) | $4.50 per million, first 1M/month free |
| Storage | $0.015 per GB-month, first 10 GB free |
| Egress | **$0, at any volume** |

Three consequences fall straight out of that table:

- **Storage is free and will stay free.** The whole pyramid, all five levels of
  5,000 rooms, is **554 MB** — 5% of the free tier. Uploading it is 25,005
  writes against a 1,000,000-write monthly allowance.
- **Bandwidth is free.** The pyramid's byte savings are worth nothing on the
  invoice. They are worth a great deal on the wire, which is a performance
  argument, not a cost one — see §4.
- **Only request counts can generate a bill**, and only above 10M/month.

## 2. What a visit costs, in requests

Four camera paths, replayed cell by cell. A request is counted once per
distinct URL per session: fetching the same room twice is a browser cache hit
and never reaches R2, so the in-memory LRU in `tiles.js` evicting a tile costs
a decode, not an operation. *(This assumes the objects are served immutable —
see §6.)*

| serving | glance | browse | survey | scholar | **mixed** |
| --- | ---: | ---: | ---: | ---: | ---: |
| no pyramid — level 0 only | 69 | 556 | 4,864 | 4,879 | **406** |
| full pyramid | 138 | 1,414 | 5,064 | 6,111 | **660** |
| pyramid, no warm-coarser | 69 | 858 | 5,064 | 6,069 | **497** |
| pyramid + L4 as 8 sheets | 138 | 867 | 209 | 1,241 | **308** |
| pyramid + L4/L3 as sheets | 138 | 309 | 84 | 515 | **178** |

- **glance** — arrive, drag a screen or two, leave.
- **browse** — pull back, cross some ground, look closely at four rooms.
- **survey** — all the way out, serpentine across the entire library.
- **scholar** — survey, two searches, then twenty rooms up close.
- **mixed** — 75/20/3/2 weighting of the above. The softest number here.

The thing to notice is **where the pyramid's overhead comes from**. On the
survey path — the one with the most requests by far — the pyramid costs 5,064
against 4,864, a **4% premium**, because a room seen only from far away is
fetched once, at level 4, instead of once at level 0. The multiplier appears on
the *browse* path (556 → 1,414), where the camera crosses level bands
repeatedly and each crossing re-fetches the same rooms at a new size. That is
the pyramid's true cost: not five images per room, but one image per room *per
level you actually look at it from*, which is usually one and occasionally
three.

## 3. What that costs per month

Mixed traffic, no CDN cache assumed in front (the conservative case — see §6):

| serving | 1k visits | 10k | 100k | 1M | 10M |
| --- | ---: | ---: | ---: | ---: | ---: |
| no pyramid | $0 | $0 | $11.03 | $142.72 | $1,459.62 |
| full pyramid | $0 | $0 | $20.18 | $234.16 | $2,373.98 |
| pyramid, no warm-coarser | $0 | $0 | $14.28 | $175.19 | $1,784.34 |
| pyramid + L4 as 8 sheets | $0 | $0 | $7.49 | $107.28 | $1,105.16 |
| pyramid + L4/L3 as sheets | $0 | $0 | $2.81 | $60.52 | $637.63 |

Free-tier headroom, which is the number that actually decides this:

| serving | visits/month before the first cent |
| --- | ---: |
| full pyramid | **15,141** |
| pyramid, no warm-coarser | 20,134 |
| no pyramid | 24,603 |
| pyramid + L4 as 8 sheets | 32,468 |
| pyramid + L4/L3 as sheets | 56,141 |

And the ceiling worth keeping in mind: **one visitor cannot cost more than the
corpus.** Every room at every level is 25,005 objects — about **$0.009** for a
visit that exhaustively scrapes the entire library. A thousand such scrapes a
month still comes in under $6.

> **The full pyramid gets ~15,000 visits a month for free, and costs $20/month
> at 100,000.** Against your stated expectation, this is not a cost problem.

## 4. Performance, which is the real argument

The bill was never the pyramid's justification. This is:

| serving | glance | browse | survey | scholar | mixed |
| --- | ---: | ---: | ---: | ---: | ---: |
| no pyramid | 4.2 MB | 33.7 MB | **294.9 MB** | 295.8 MB | 24.6 MB |
| full pyramid | 3.1 MB | 10.5 MB | **8.0 MB** | 21.1 MB | 5.1 MB |

Serving level 0 to a zoomed-out screen means pushing **295 MB** to someone who
is looking at 64-pixel-wide thumbnails, and decoding ~5,000 full-size JPEGs to
do it. The pyramid does the same tour in 8 MB. The measured ladder:

| level | size | encoded | decoded RGBA | whole corpus |
| ---: | --- | ---: | ---: | ---: |
| 0 | 1024×768 | 59.2 KB | 3.00 MB | 303 MB |
| 1 | 512×384 | 33.5 KB | 0.75 MB | 172 MB |
| 2 | 256×192 | 10.8 KB | 0.19 MB | 55 MB |
| 3 | 128×96 | 3.5 KB | 0.05 MB | 18 MB |
| 4 | 64×48 | 1.2 KB | 0.01 MB | **6.1 MB** |

That last cell is the interesting one: **the entire library at thumbnail
resolution is a 6 MB download.**

## 5. The re-rank, and why sheets are keyed by room ID

Tiling images into sheets is complicated by the arrangement being mutable — but
only if the sheets are keyed by *map position*. Key them by **room ID** instead
and the problem disappears: the arrangement is mutable, the ID is not, so a
re-rank cannot invalidate a sheet. And since a zoomed-out screen is scattered
across the whole ID space anyway, the natural sheet set is *the whole corpus at
that level*, which is 6.1 MB at level 4.

What a search costs, measured — one settled screen, then a new order:

| serving | camera | first view | after re-rank |
| --- | --- | ---: | ---: |
| per room | zoomed out (L4) | 669 | **+579** |
| per room | mid (L3) | 282 | +272 |
| per room | default (L1) | 60 | +56 |
| L4 as 8 sheets | zoomed out (L4) | **9** | **+0** |
| L4 as 8 sheets | mid (L3) | 150 | +136 |
| L4 as 8 sheets | default (L1) | 60 | +56 |

Zoomed out with level 4 sheeted, **a search costs zero requests**. The whole
corpus is already resident at that resolution, so re-ranking is a pure redraw —
which is exactly what the concept asks for, the library visibly rearranging
itself rather than reloading. That is a *feel* argument as much as a cost one,
and it is the strongest reason to build sheets eventually.

Level 3 is where sheeting stops paying: it cuts requests further but pushes
browse from 10.5 MB to 32 MB, because a level-3 atlas of the corpus is 18 MB
whether you need all of it or not. **Sheet level 4, leave the rest per room.**

## 6. Assumptions, and which ones are soft

Ranked by how much damage they'd do if wrong.

1. **Prices are unverified.** `developers.cloudflare.com` was unreachable from
   the sandbox that produced this (egress policy, not a network fault), so the
   rates come from search summaries of the official pricing pages. They agree
   with the figures quoted in the brief and with long-published rates, but
   **nobody has read them off the source here.** Check the dashboard before
   acting on any total.
2. **The CDN cache question is genuinely unsettled.** Cloudflare's billing docs
   say a cache hit avoids origin fetches including R2 operations, which would
   make everything above a large overestimate — a 90% hit ratio puts 100k
   visits/month back inside the free tier. But multiple community reports
   describe being billed Class B *despite* `cf-cache-status: HIT` on R2 custom
   domains, and others describe R2 custom domains returning `DYNAMIC` and never
   caching at all. **Every table above assumes no cache**, which is the safe
   direction to be wrong in. If you deploy, measure this on your own account
   before relying on it. Note that caching needs a custom domain — `r2.dev`
   does not support it.
3. **The traffic mix is a guess.** 75% glance / 20% browse / 3% survey / 2%
   scholar. Weighting it entirely toward the survey path — every visitor tours
   the whole library — still only reaches 5,064 ops/visit, so free-tier
   headroom would be ~1,970 visits/month rather than 15,141. Even the
   pessimistic reading is not alarming.
4. **Byte sizes are measured on a lossy sample.** The 26 sample images are
   already compressed below the pipeline's quality, so a fresh render at q82
   would likely be 1.5–3× larger at level 0. That moves the storage line (still
   far inside the free tier) and the download times; **it does not move the
   operation counts**, which are what the bill is made of.
5. **Distinct-URL counting assumes immutable objects.** Serve the corpus with a
   long `Cache-Control: max-age, immutable` and a content-addressed or
   versioned path. Without that, a revisit re-validates and the model
   understates requests. This is a deployment detail that is entirely under our
   control, and getting it wrong is the one way to make these numbers lie badly.
6. **The pyramid is modelled as planned, not as built.** The render loop still
   fetches level 0 for every cell; `pyramid.js` is written and tested but not
   yet wired into `tiles.js` and the loop. Today's app behaves like the "no
   pyramid" row.

## 7. What to do

**Now: nothing.** Finish wiring the pyramid for the performance reasons it was
always for. At the expected traffic the operation cost is zero, and the
difference between the best and worst options on this page is $20/month at a
traffic level this project is unlikely to reach.

**Cheap insurance, when deploying:**

- Put a **custom domain** in front of the bucket so the CDN cache is even
  possible, and set **immutable, long-max-age** headers on every level. Both
  are free and both are load-bearing for every number here.
- Consider dropping **`warmCoarser`** if requests ever matter — it is one flag
  in `pyramid.js`, it saves 25% of operations, and it costs a little smoothness
  when zooming out. Not worth doing pre-emptively.

**Later, if it earns its place: sheet level 4 by room ID.** ~8 sheets, 6.1 MB
total, built by the pipeline alongside the mips. It halves mixed operations,
makes the zoomed-out view a fixed 8 requests regardless of corpus size, and
makes a search re-rank cost **nothing** at that zoom. Do it for the last
reason, not the first — it is the interaction the whole project is named after.

**Not Cloudflare Images.** At $1 per 100,000 delivered it is $10/million
against R2's $0.36/million — about **28× more expensive** for exactly this
workload, and it prices the free tier away entirely: 100k visits/month would
cost ~$662 instead of $20.
