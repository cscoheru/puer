#!/bin/bash
# auto-post cron wrapper -- extracts DB_PASSWORD from .env and sets up
# the host-runnable DATABASE_URL pointing at the postgres container IP.
set -eu
cd /opt/puer-hub
DB_PWD=$(grep "^DB_PASSWORD=" .env | cut -d= -f2 | tr -d "\"")
export DATABASE_URL="postgresql://puerhub:${DB_PWD}@172.18.0.2:5432/puerhub"
export AUTO_TEA_DRAFT_AUTHOR_ID="cmpb7net1000001ocrss0o4de"
export AUTO_TEA_DRAFT_BOARD_ID="169748e7-123e-40f5-b283-b016c83f9c32"
exec ./node_modules/.bin/tsx scripts/auto-post.mjs --apply
