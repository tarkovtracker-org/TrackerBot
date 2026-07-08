#!/bin/bash
set -e

echo "Deploy TrackerBot (main)"

cd "$(dirname "$0")"

echo "Update from main"
git fetch origin
git checkout main
git reset --hard origin/main

echo "Install deps (production only)"
npm ci --omit=dev

echo "PM2 reload"
pm2 start ecosystem.config.cjs || true
pm2 reload ecosystem.config.cjs --update-env

echo "Save PM2 state"
pm2 save

echo "Deploy finished"
