# Changelog

## [1.4.1](https://github.com/centuryglass/babel-index/compare/babel-index-v1.4.0...babel-index-v1.4.1) (2026-09-19)


### Bug Fixes

* correct relative fragment URL in admin log viewer polling script ([#222](https://github.com/centuryglass/babel-index/issues/222)) ([ec4e266](https://github.com/centuryglass/babel-index/commit/ec4e266fce15c8932ec7bbca44d0976932c6e1bd))
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
