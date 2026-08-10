# Two stages so the runtime image carries production dependencies only.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile is present, `npm install` on the very first build.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Never run as root: a container that only reads documents has no reason to.
USER node

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Cloud Run injects PORT; the default keeps `docker run` working unchanged.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server.js"]
