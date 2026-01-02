#!/bin/bash
set -e

echo "Deploy TrackerBot-prod"

cd "$(dirname "$0")"

echo "Update"
git fetch origin
git checkout prod
git reset --hard origin/prod

echo "Install deps"
npm install

echo "PM2 reload"
pm2 start ecosystem.config.cjs || true
pm2 reload ecosystem.config.cjs --update-env

echo "Save PM2 state"
pm2 save

echo "Deploy finish"
