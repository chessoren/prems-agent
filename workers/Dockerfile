# Two stages: the build needs TypeScript and the workspace, the runtime needs
# neither. What ships is compiled JavaScript and production dependencies.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json ./packages/core/
COPY workers/package.json ./workers/
RUN npm ci
COPY packages/core ./packages/core
COPY workers ./workers
RUN npx tsc -b workers

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY workers/package.json ./workers/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/workers/dist ./workers/dist
# Non-root: the container makes outbound HTTP to sites we do not control.
USER node
CMD ["node", "workers/dist/index.js"]
