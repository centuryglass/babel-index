# The demo server, containerized. No corpus, config, or remote address is
# baked in - packages/server/index.ts already takes all of that as CLI flags
# (--images/--shared-dir/--config for a local corpus, --remote/--prefix for
# one already uploaded with tools/upload/upload-r2.ts - see index.ts's own
# header comment), so the same image works either way depending on what's
# passed to `docker run` and whether a corpus directory is bind-mounted in.
#
# Local corpus:
#   docker run -p 5173:5173 -v /srv/babel-corpus:/data/corpus:ro \
#     babel-index --images /data/corpus
#
# Remote corpus (nothing to mount):
#   docker run -p 5173:5173 babel-index --remote https://assets.example.com --prefix corpus-sample
FROM node:20-slim

WORKDIR /app

# Separate from the full COPY below so `npm ci` is only re-run when the
# lockfile actually changes, not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 5173
ENTRYPOINT ["node", "--import", "./build/register.mjs", "packages/server/index.ts"]
# No CMD: with no flags, index.ts falls back to the committed sample corpus,
# same as a bare `npm run demo` - useful for `docker run babel-index` as a
# smoke test, but pass --images or --remote for anything real.
