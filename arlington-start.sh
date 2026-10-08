#!/usr/bin/env bash
set -Eeuo pipefail

echo "🔄 Applying refreshed Arlington proxy before Multilogin startup..."
node /app/updateArlingtonProxy.js

echo "✅ Proxy update finished; starting Arlington scraper entrypoint..."
exec /app/railway-entrypoint.sh
