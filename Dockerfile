FROM node:24@sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

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

FROM base AS eudiplo
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

# Set the default FOLDER environment variable
ENV FOLDER=/app/config
ENV CONFIG_FOLDER=/app/config/config

WORKDIR /app
EXPOSE 3000

# --- Healthcheck dependencies ---
# Install curl for HEALTHCHECK
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# --- HEALTHCHECK ---
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Run compiled NestJS app
CMD [ "node", "dist/main.js" ]

FROM eudiplo AS eudiplo-demo
# Opt-in demo bootstrap from embedded sample config.
ENV BOOTSTRAP_DEMO=true

# Bundle demo configuration so users can run without downloading repo config files.
COPY assets/config/demo /app/demo-config/demo

# Seed demo config only when the target config folder is empty.
COPY apps/backend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD [ "node", "dist/main.js" ]

FROM nginx:alpine@sha256:72ba65eb42c10344912a84ff42408db7d34f2feb642204570ab8fc5ffd29f1d3 AS client
# Copy the Angular build output into the nginx html directory.
# The Angular output path is configured as apps/client/dist/apps/client in angular.json.
COPY --from=build-frontend /usr/src/app/apps/client/dist/apps/client/browser /usr/share/nginx/html

# Copy nginx configuration
COPY apps/client/nginx.conf /etc/nginx/nginx.conf

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
