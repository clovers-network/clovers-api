# The runtime, stated explicitly.
#
# This is the deploy artifact for Fly, and the thing the local verification runs
# against, so "works on my machine" and "works in production" are the same
# claim. It is also what keeps the Cloudflare option honest: anything that only
# works because of something on the old droplet shows up here as a failure.
#
# node:22-slim because node:sqlite is built in from 22.4 -- there is no native
# SQLite module to compile. See NODE-UPGRADE.md for why Node 16 is not viable.
FROM node:22-slim

WORKDIR /app

# --ignore-scripts is not a shortcut, it is required:
#   * sha3's bundled `nan` cannot compile against Node 22's V8 API, and sha3 is
#     not installed on the current production box either -- it is lockfile dead
#     weight that nothing imports.
#   * svg-to-png pulls phantomjs-prebuilt, whose install script downloads and
#     unpacks a 23 MB binary this app never invokes.
# Skipping both means the image needs no compiler, no Python and no bzip2.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# Dev dependencies are installed on purpose: .babelrc uses transform-runtime, so
# the compiled dist/ requires babel-runtime at runtime, and babel-runtime is a
# devDependency. `npm ci --omit=dev` produces an app that cannot start.
COPY . .
RUN npm run build

# The database lives on a mounted volume, not in the image.
ENV SQLITE_PATH=/data/clovers_chain_1.db
ENV PORT=4444
VOLUME /data
EXPOSE 4444

CMD ["node", "dist/index.js"]
