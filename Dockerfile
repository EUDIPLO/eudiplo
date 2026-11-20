FROM node:26-trixie@sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Node 25 and later no longer bundle corepack, so install it before enabling it.
RUN npm install -g corepack@0.36.0 && corepack enable

FROM base AS build
COPY . /usr/src/app
WORKDIR /usr/src/app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM build AS build-backend
# Build backend only
RUN pnpm --filter @eudiplo/config-format build
RUN pnpm --filter @eudiplo/backend build
RUN pnpm deploy --filter=@eudiplo/backend --prod /prod/backend

FROM build AS build-frontend
# Build SDK first (required by both Angular apps), then client
RUN pnpm --filter @eudiplo/sdk-core build
RUN pnpm --filter @eudiplo/client build

# The runtime only needs node and the compiled app, so it uses the slim image
# instead of the full one with build tools and image libraries. Native modules
# (better-sqlite3, bcrypt, pkcs11js) are built in the base stage, so both
# FROM lines must name the same Debian release (trixie).
FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS eudiplo
# Copy production dependencies for backend and built dist
COPY --from=build-backend /prod/backend /app
COPY --from=build-backend /usr/src/app/apps/backend/dist /app/dist

# Accept VERSION and REVISION (git commit) as build arguments and set as environment variables.
# The client compares both against the backend to detect incompatible deployments.
ARG VERSION=dev
ENV VERSION=$VERSION
ARG REVISION=
ENV REVISION=$REVISION

# Set production environment
ENV NODE_ENV=production

# /app/config is the data volume: FOLDER holds the SQLite database and, by
# default, the local uploads folder. Tenant config folders and kms.json live in
# its config/ subfolder, because every folder in CONFIG_FOLDER is treated as a
# tenant folder (mirrors the repository's assets/ folder). Setups that mount a
# config-only folder at /app/config must set CONFIG_FOLDER=/app/config.
ENV FOLDER=/app/config
ENV CONFIG_FOLDER=/app/config/config

WORKDIR /app
EXPOSE 3000

# --- OS packages ---
# Upgrade the packages of the pinned base image, so Debian security fixes
# released after that digest was built are part of the image. Keep this step
# below ARG REVISION: the revision changes with every commit, so the step is
# not served from the build cache.
# Install curl for HEALTHCHECK. The compose files in docker-compose.yml,
# deployment/docker-compose and the CLI template also run curl in this image.
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# --- Package managers ---
# The app runs with node alone, so npm is removed: it comes with the base image
# and brings its own dependencies, which nothing in this image updates. The
# checks fail the build when a new base image ships a package manager or
# another global package.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && for bin in npm npx yarn yarnpkg corepack; do \
         if command -v "$bin"; then echo "unexpected package manager in the runtime image: $bin" >&2; exit 1; fi; \
       done \
    && if [ -n "$(ls -A /usr/local/lib/node_modules)" ]; then \
         echo "unexpected global packages in the runtime image:" >&2; ls -A /usr/local/lib/node_modules >&2; exit 1; \
       fi

# --- HEALTHCHECK ---
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Run compiled NestJS app
CMD [ "node", "dist/main.js" ]

FROM nginx:alpine@sha256:0563c36f94a6d3ec3584161b77859f740f7e20b4853f52c796a864ce6908e8ea AS client
# Copy the Angular build output into the nginx html directory.
# The Angular output path is configured as apps/client/dist/apps/client in angular.json.
COPY --from=build-frontend /usr/src/app/apps/client/dist/apps/client/browser /usr/share/nginx/html

# Copy nginx configuration
COPY apps/client/nginx.conf /etc/nginx/nginx.conf
COPY apps/client/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf

# Copy entrypoint script
COPY apps/client/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Accept VERSION and REVISION (git commit) as build arguments and set as environment variables.
# The client compares both against the backend to detect incompatible deployments.
ARG VERSION=dev
ENV VERSION=$VERSION
ARG REVISION=
ENV REVISION=$REVISION

# Environment variables with defaults
ENV API_BASE_URL=http://localhost:3000

# --- Security: Run as non-root user ---
# Create nginx user/group and fix permissions
RUN addgroup -g 101 -S nginx || true && \
    adduser -S -D -H -u 101 -h /var/cache/nginx -s /sbin/nologin -G nginx -g nginx nginx || true && \
    chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    rm -f /var/log/nginx/access.log /var/log/nginx/error.log && \
    touch /var/log/nginx/access.log /var/log/nginx/error.log && \
    chown -R nginx:nginx /var/log/nginx && \
    chown -R nginx:nginx /etc/nginx/conf.d

USER nginx

# Expose port 8080 (non-privileged for rootless container compatibility)
EXPOSE 8080

# --- HEALTHCHECK (Client / Nginx) ---
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO /dev/null http://localhost:8080/health || exit 1

# Use our custom entrypoint script
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
