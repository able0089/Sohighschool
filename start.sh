#!/bin/sh
set -e

echo "Running database migrations..."
pnpm --filter @workspace/db run push

echo "Starting bot..."
node --enable-source-maps ./artifacts/api-server/dist/index.mjs
