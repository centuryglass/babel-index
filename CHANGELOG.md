# Changelog

## [1.7.0](https://github.com/centuryglass/babel-index/compare/babel-index-v1.6.0...babel-index-v1.7.0) (2026-09-22)


### Features

* start the loading indicator when a search is submitted, not once it resolves ([#308](https://github.com/centuryglass/babel-index/issues/308)) ([cb6f83c](https://github.com/centuryglass/babel-index/commit/cb6f83c175ea43d02f3b0de91e62c9c90b097574))


### Bug Fixes

* gate the favorite badge's draw and interactivity by zoom ([#311](https://github.com/centuryglass/babel-index/issues/311)) ([622dc23](https://github.com/centuryglass/babel-index/commit/622dc23349b9550e57b2317713340a2d14ddbef5))
* reconcile the two names for a generic cell to "a library wall" ([#305](https://github.com/centuryglass/babel-index/issues/305)) ([09cffb3](https://github.com/centuryglass/babel-index/commit/09cffb362f129e2531c8c2ee0e59b7b5bea0c2f1)), closes [#249](https://github.com/centuryglass/babel-index/issues/249)


### Performance Improvements

* stop allocating a string key, object, or id string on every rendered cell ([#309](https://github.com/centuryglass/babel-index/issues/309)) ([0c4f390](https://github.com/centuryglass/babel-index/commit/0c4f390894b666261903a38b10b5ccfad555cdd1)), closes [#256](https://github.com/centuryglass/babel-index/issues/256)

## [1.6.0](https://github.com/centuryglass/babel-index/compare/babel-index-v1.5.0...babel-index-v1.6.0) (2026-09-22)


### Features

* build the Dockerfile as a non-blocking post-release check ([#287](https://github.com/centuryglass/babel-index/issues/287)) ([757705e](https://github.com/centuryglass/babel-index/commit/757705eb5e89905fa7b1482f6444dca843959971)), closes [#246](https://github.com/centuryglass/babel-index/issues/246)
* give generic_distill its own resolution pyramid ([#299](https://github.com/centuryglass/babel-index/issues/299)) ([ad5092a](https://github.com/centuryglass/babel-index/commit/ad5092af64c64d1065af795e79ef514c2f975cbd)), closes [#293](https://github.com/centuryglass/babel-index/issues/293)
* log hourly usage metrics without persisting visitor data ([#290](https://github.com/centuryglass/babel-index/issues/290)) ([9c31042](https://github.com/centuryglass/babel-index/commit/9c31042e4ccd80d519763018146cf4ad0b649af4)), closes [#282](https://github.com/centuryglass/babel-index/issues/282)


### Bug Fixes

* make a search and a favorite sort mutually exclusive ([#292](https://github.com/centuryglass/babel-index/issues/292)) ([d72a38f](https://github.com/centuryglass/babel-index/commit/d72a38f0dd6d3bbce53e27fd1d2b27aaa9a0f06f))
* stop the prefetch ring computing ids past its queue cap ([#297](https://github.com/centuryglass/babel-index/issues/297)) ([807c640](https://github.com/centuryglass/babel-index/commit/807c640f4c3396adb10804f2d0326f03aa340f65))
* unify hover-glow gold between the open book, shelf controls, and canvas ([#294](https://github.com/centuryglass/babel-index/issues/294)) ([f566e12](https://github.com/centuryglass/babel-index/commit/f566e128e4ef5d6538d6c1786dafa5fdae370218)), closes [#263](https://github.com/centuryglass/babel-index/issues/263)


### Performance Improvements

* batch pointermove hit-testing to once per animation frame ([#295](https://github.com/centuryglass/babel-index/issues/295)) ([ef50345](https://github.com/centuryglass/babel-index/commit/ef5034523c52dc40bc4d605f7a115b99e86feb4e)), closes [#260](https://github.com/centuryglass/babel-index/issues/260)
* cache the center shelf's spine font fit on the Canvas2D path ([#288](https://github.com/centuryglass/babel-index/issues/288)) ([4040c13](https://github.com/centuryglass/babel-index/commit/4040c1383bdfdeb33319ca18cb46858867dc0e19)), closes [#253](https://github.com/centuryglass/babel-index/issues/253)
* dedupe the coarser-level warm pass to distinct ids ([#301](https://github.com/centuryglass/babel-index/issues/301)) ([e390e25](https://github.com/centuryglass/babel-index/commit/e390e25332c7a126f44a27f577bb4d6838a45ae7)), closes [#296](https://github.com/centuryglass/babel-index/issues/296)

## [1.5.0](https://github.com/centuryglass/babel-index/compare/babel-index-v1.4.1...babel-index-v1.5.0) (2026-09-21)


### Features

* auto-pull GitHub issues in cloud sessions without gh or a token ([#272](https://github.com/centuryglass/babel-index/issues/272)) ([ed0fd4c](https://github.com/centuryglass/babel-index/commit/ed0fd4cb8eb1b65cd399e33b6e3e9f27c794cb51))


### Bug Fixes

* bound stubRanking's hashing loop independently of config ([#281](https://github.com/centuryglass/babel-index/issues/281)) ([4bf31dd](https://github.com/centuryglass/babel-index/commit/4bf31ddf608a224f146b60e8a2040169af61ea2f)), closes [#276](https://github.com/centuryglass/babel-index/issues/276)
* carry the int8 quantisation scale through the manifest ([#285](https://github.com/centuryglass/babel-index/issues/285)) ([ada38c6](https://github.com/centuryglass/babel-index/commit/ada38c66323fb0e52c61e83c4f00f2a170e91bae)), closes [#231](https://github.com/centuryglass/babel-index/issues/231)
* import comments into the GitHub issues cache ([#280](https://github.com/centuryglass/babel-index/issues/280)) ([53cffcf](https://github.com/centuryglass/babel-index/commit/53cffcf3d540c6578dadf98b6f64ed1e1f80f0f2)), closes [#279](https://github.com/centuryglass/babel-index/issues/279)
* remove unreachable reset() from the GL texture caches ([#271](https://github.com/centuryglass/babel-index/issues/271)) ([aa077d2](https://github.com/centuryglass/babel-index/commit/aa077d22bdde23963d6e35d3b46dab4daf256199)), closes [#264](https://github.com/centuryglass/babel-index/issues/264)
* surface a corpus fetch failure in the debug HUD ([#284](https://github.com/centuryglass/babel-index/issues/284)) ([db62b64](https://github.com/centuryglass/babel-index/commit/db62b645a7bfc7700f8400091f1e294d7d1d38d5)), closes [#250](https://github.com/centuryglass/babel-index/issues/250)

## [1.4.1](https://github.com/centuryglass/babel-index/compare/babel-index-v1.4.0...babel-index-v1.4.1) (2026-09-20)


### Bug Fixes

* correct relative fragment URL in admin log viewer polling script ([#222](https://github.com/centuryglass/babel-index/issues/222)) ([ec4e266](https://github.com/centuryglass/babel-index/commit/ec4e266fce15c8932ec7bbca44d0976932c6e1bd))
* match multi-word tags typed plainly, and report match strength ([#234](https://github.com/centuryglass/babel-index/issues/234)) ([f71a7dc](https://github.com/centuryglass/babel-index/commit/f71a7dc5a48ebcad05758b188665ddbaaca616c6))
* suppress the compatibility click after a touch tap on the canvas ([#233](https://github.com/centuryglass/babel-index/issues/233)) ([02b4968](https://github.com/centuryglass/babel-index/commit/02b4968ea1b65a891369b3bcb62417d0c83985c4))
* wrap long room titles instead of truncating in overlay header ([#221](https://github.com/centuryglass/babel-index/issues/221)) ([5e19673](https://github.com/centuryglass/babel-index/commit/5e196731f1e61077d19d44f0bed51dfdf470c4a0))

## [1.4.0](https://github.com/centuryglass/babel-index/compare/babel-index-v1.3.0...babel-index-v1.4.0) (2026-09-19)


### Features

* add an authenticated admin log viewer ([#219](https://github.com/centuryglass/babel-index/issues/219)) ([abc341f](https://github.com/centuryglass/babel-index/commit/abc341f5639b92c9d4cf2ac26ae2d2c8395590c3))

## [1.3.0](https://github.com/centuryglass/babel-index/compare/babel-index-v1.2.0...babel-index-v1.3.0) (2026-09-19)


### Features

* give the shared tiles their own resolution pyramid ([#207](https://github.com/centuryglass/babel-index/issues/207)) ([1db297b](https://github.com/centuryglass/babel-index/commit/1db297bfe56b44ab5623a018595174ffd8900583))


### Bug Fixes

* mark bundle.js, style.css and SSR pages no-cache ([#206](https://github.com/centuryglass/babel-index/issues/206)) ([60c521f](https://github.com/centuryglass/babel-index/commit/60c521fbeb2f6d136ff5ff8672f0d5777b8f1384))

## [1.2.0](https://github.com/centuryglass/babel-index/compare/babel-index-v1.1.0...babel-index-v1.2.0) (2026-09-19)


### Features

* add /help, /about and /babel-book SSR-linkable permalinks ([#204](https://github.com/centuryglass/babel-index/issues/204)) ([9f49602](https://github.com/centuryglass/babel-index/commit/9f4960268906c1fe464974574b9e738cdae9bc09))
* add /map/:room permalinks alongside /catalog/:room ([#203](https://github.com/centuryglass/babel-index/issues/203)) ([ad6c360](https://github.com/centuryglass/babel-index/commit/ad6c360bc1f8727d34a675f4e2502691b34f43d7))


### Bug Fixes

* deploy only on release-please's release merge ([#201](https://github.com/centuryglass/babel-index/issues/201)) ([760a3cd](https://github.com/centuryglass/babel-index/commit/760a3cd40ee8fbbaece8031eacb2faa36afd9def))


### Performance Improvements

* drop the redundant full-screen clear from both renderers ([#205](https://github.com/centuryglass/babel-index/issues/205)) ([6055159](https://github.com/centuryglass/babel-index/commit/605515958ed4706555e551c38bcedb4d57f22526))

## [1.1.0](https://github.com/centuryglass/babel-index/compare/babel-index-v1.0.0...babel-index-v1.1.0) (2026-09-18)


### Features

* address room permalinks by title rather than image filename ([#197](https://github.com/centuryglass/babel-index/issues/197)) ([7ce53df](https://github.com/centuryglass/babel-index/commit/7ce53df3e92dd18d3f92471f79be3abb2e79df9c))


### Bug Fixes

* stop forcing a synchronous layout on every map frame ([#198](https://github.com/centuryglass/babel-index/issues/198)) ([a9e098d](https://github.com/centuryglass/babel-index/commit/a9e098d6f3e68f6f9425f521fac83a07d5e46906))

## 1.0.0 (2026-09-18)


### Features

* add human-facing architecture doc and enforce the file map in CI ([#190](https://github.com/centuryglass/babel-index/issues/190)) ([677ea5f](https://github.com/centuryglass/babel-index/commit/677ea5f87219986affcb4fac04018cb5d614bc6f))
* add release-please version discipline ([#189](https://github.com/centuryglass/babel-index/issues/189)) ([8e4ff91](https://github.com/centuryglass/babel-index/commit/8e4ff91510a1c863eb91f58d0782fcd89206cf9b))


### Bug Fixes

* give the catalog tile button a stack level so its float wins clicks ([#193](https://github.com/centuryglass/babel-index/issues/193)) ([a9c6328](https://github.com/centuryglass/babel-index/commit/a9c6328091dc2790f1aad4782a85ec5d585c0b39))
* require exact source dimensions in the pipeline preflight ([#191](https://github.com/centuryglass/babel-index/issues/191)) ([7d26877](https://github.com/centuryglass/babel-index/commit/7d268778aca38f2fd8ed41e222602b751abb49f8))
