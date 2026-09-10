# The offline demo server, containerized. No compiled output ever hits disk
# in this repo (packages/server/index.ts bundles the client with esbuild at
# startup, see AGENTS.md), so this build has nothing to `npm run build` -
# it's an install stage plus a runtime stage, not a compile stage.
#
#   docker build -t babel-index .
#   docker run -p 5173:5173 babel-index
#   docker run -p 5173:5173 -v /path/to/rooms:/data:ro babel-index --images /data
#
# WITH_CLIP (default: true) controls whether the optional CLIP text tower
# (@huggingface/transformers, onnxruntime-node) is installed. It only
# publishes native binaries for win32/darwin/linux (AGENTS.md), which covers
# this image's linux base, but it's sizeable and downloads model weights on
# first search - pass `--build-arg WITH_CLIP=false` for a smaller image that
# ranks by keywords and story only, matching the README's "lighter test
# build" option.
#
#   docker build --build-arg WITH_CLIP=false -t babel-index .

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# node-gyp fallback for any optional dep without a prebuilt binary for the
# target arch (e.g. onnxruntime-node on non-x64) - not needed at runtime, so
# it lives only in this stage and is never copied into the final image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
ARG WITH_CLIP=true
RUN if [ "$WITH_CLIP" = "true" ]; then npm ci --omit=dev; else npm ci --omit=dev --omit=optional; fi

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY build ./build
COPY packages ./packages
COPY assets ./assets
# packages/web imports tile geometry straight out of tools/center-placement/lib
# at bundle time (AGENTS.md: "no second copy to drift") - the client build
# fails without it even though nothing else here runs the tools/ CLIs.
COPY tools/center-placement/lib ./tools/center-placement/lib
EXPOSE 5173
# CMD (not baked into ENTRYPOINT) so `docker run babel-index --images /data
# --port 8080` overrides it entirely, same as any other npm run demo flag
# (see packages/server/index.ts).
ENTRYPOINT ["node", "--import", "./build/register.mjs", "packages/server/index.ts"]
CMD ["--images", "assets/corpus-sample"]
