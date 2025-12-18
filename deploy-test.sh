#!/bin/bash
set -e

echo "Deploy TrackerBot-test"

cd "$(dirname "$0")"

echo "Update"
git fetch origin
git checkout test
git pull origin test

echo "Install deps"
npm install

echo "PM2 reload"
pm2 start ecosystem.config.cjs || true
pm2 reload ecosystem.config.cjs --update-env

echo "Save PM2 state"
pm2 save

echo "Deploy finish"
