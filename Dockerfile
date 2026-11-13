# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --strict-ssl=true; else npm ci --strict-ssl=true; fi
COPY web ./
ARG VITE_OIDC_AUTHORITY
ARG VITE_OIDC_CLIENT_ID
ARG VITE_OIDC_SCOPE
RUN npm run build
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --strict-ssl=true; else npm ci --strict-ssl=true; fi
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN --mount=type=cache,target=/root/.npm \
    npm run build && npm prune --omit=dev --offline && \
    mkdir /runtime && mv node_modules dist package.json migrations /runtime/
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node --from=build /runtime/ ./
COPY --chown=node:node --from=web-build /web/dist ./web/dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
