# syntax=docker/dockerfile:1
#
# One image for the web server and the background worker (docs/DEPLOYMENT.md):
#   web     the default command: next start on $PORT (3000 unless the platform sets it)
#   worker  node --conditions=react-server dist/scripts/worker.cjs
#   schema  node --conditions=react-server dist/scripts/init-db.cjs   (before each release)
#
#   docker build -t corpus .
#   docker run --env-file .env -p 3000:3000 corpus

ARG NODE_VERSION=24

# ── Dependencies, including the build tools ─────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# postinstall copies the pdf.js library into public/.
COPY scripts/copy-pdf-worker.mjs scripts/
RUN npm ci --no-audit --no-fund

# ── Build: the Next.js app and the bundled scripts, then drop dev dependencies ──
FROM deps AS build
COPY . .
RUN npm run build \
 && npm run build:scripts \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf .next/cache

# ── Runtime: production dependencies only, no source, not root ───────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000
# The application stays owned by root, so the app cannot modify itself; only .next (runtime cache) is writable.
COPY --from=build /app/package.json /app/next.config.mjs ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY --from=build /app/dist ./dist
COPY --from=build --chown=node:node /app/.next ./.next
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
