#!/bin/bash
set -e

echo "Deploy TrackerBot-test"

cd "$(dirname "$0")"

echo "Update"
git fetch origin
git checkout test
git reset --hard origin/test

echo "Install deps"
npm install

echo "Clean legacy PM2 processes"
for app in TrackerBot-Prod_test TrackerBot-Web_test TrackerBot-Admin_test TrackerBot:bot TrackerBot:web TrackerBot:admin; do
  pm2 delete "$app" >/dev/null 2>&1 || true
done

echo "PM2 reload"
pm2 start ecosystem.config.cjs || true
pm2 reload ecosystem.config.cjs --update-env

echo "Save PM2 state"
pm2 save

echo "Deploy finish"
