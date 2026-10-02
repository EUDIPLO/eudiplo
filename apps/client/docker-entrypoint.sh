#!/bin/sh
# Recreate env.js file with runtime environment variables

# Set defaults if not provided
API_BASE_URL=${API_BASE_URL:-http://localhost:3000}
VERSION=${VERSION:-dev}
REVISION=${REVISION:-}
CLIENT_BASE_HREF=${CLIENT_BASE_HREF:-/}

# Handle empty string case
if [ -z "$CLIENT_BASE_HREF" ]; then
  CLIENT_BASE_HREF="/"
fi

# Normalize CLIENT_BASE_HREF: must start and end with /
case "$CLIENT_BASE_HREF" in
  /*) ;;
  *) CLIENT_BASE_HREF="/$CLIENT_BASE_HREF" ;;
esac
case "$CLIENT_BASE_HREF" in
  */) ;;
  *) CLIENT_BASE_HREF="$CLIENT_BASE_HREF/" ;;
esac

# Validate CLIENT_BASE_HREF contains only safe characters
if ! echo "$CLIENT_BASE_HREF" | grep -qE '^/([a-zA-Z0-9/_-]+/)?$'; then
  echo "Error: CLIENT_BASE_HREF contains invalid characters" >&2
  exit 1
fi

if ! sed -i 's|<base href="[^"]*"[^>]*>|<base href="'"${CLIENT_BASE_HREF}"'">|g' /usr/share/nginx/html/index.html; then
  echo "Error: Failed to update base href in /usr/share/nginx/html/index.html" >&2
  exit 1
fi

# Generate timestamp for cache busting
TIMESTAMP=$(date +%s)

# Replace base href in index.html (supports both self-closing and non-self-closing variants)
sed -i 's|<base href="[^"]*"[^>]*>|<base href="'"${CLIENT_BASE_HREF}"'">|g' /usr/share/nginx/html/index.html

# Replace env.js content with timestamp in the file
cat > /usr/share/nginx/html/env.js << EOF
(function (window) {
  window['env'] = window['env'] || {};

  // Environment variables
  window['env']['apiUrl'] = '${API_BASE_URL}';

  // Application version
  window['env']['version'] = '${VERSION}';

  // Git commit the client was built from (used to check backend compatibility)
  window['env']['revision'] = '${REVISION}';

  // Cache busting timestamp (changes every container start)
  window['env']['timestamp'] = '${TIMESTAMP}';

  // Base href for the application (used for routing)
  window['env']['baseHref'] = '${CLIENT_BASE_HREF}';
})(this);
EOF

echo "index.html base href set to: ${CLIENT_BASE_HREF}"
echo "env.js configured with API_BASE_URL: ${API_BASE_URL}, VERSION: ${VERSION}, REVISION: ${REVISION}, timestamp: ${TIMESTAMP}"

# Start nginx
exec "$@"
