#!/usr/bin/env bash
# Deploy the rag-service container to the puer-hub production server.
# The dev machine has no docker — code is tarred, scp'd, and built ON the
# server (it already pulls base images for the puer-hub stack).
#
# Usage:
#   PUER_REMOTE_COMPOSE_FILES=/opt/puer-hub/docker-compose.yml ./deploy-rag.sh v1
#
# Prereqs (one-time, on the server):
#   /opt/puer-hub/rag-data/          — text corpus (sku-clean/knowledge-chunks/
#                                       donghe-skus.jsonl + chunk-emb.npy/key)
#   rag-service.yml in the production compose chain
#   /opt/puer-hub/.env               — RAG_SERVICE_TOKEN + provider keys
set -euo pipefail

RELEASE_ID="${1:?usage: deploy-rag.sh <release-id>}"
SERVER=root@207.57.134.99
SSH="ssh -J aliyun -p 16921"
SCP="scp -o ProxyJump=aliyun -P 16921"
REMOTE_SRC=/opt/puer-hub/rag-src/$RELEASE_ID
IMAGE=puer-rag-service:$RELEASE_ID
COMPOSE_FILES="${PUER_REMOTE_COMPOSE_FILES:?set PUER_REMOTE_COMPOSE_FILES (colon-separated chain)}"

COMPOSE_ARGS=""
IFS=: read -ra _FILES <<< "$COMPOSE_FILES"
for f in "${_FILES[@]}"; do COMPOSE_ARGS="$COMPOSE_ARGS -f $f"; done

cd "$(dirname "$0")"

echo "== ship code =="
tar czf /tmp/rag-src-$RELEASE_ID.tar.gz \
  service/ rag_pipeline.py retriever.py teacher_api.py image_ocr.py visual_match.py .dockerignore
$SSH "$SERVER" "mkdir -p $REMOTE_SRC"
$SCP "/tmp/rag-src-$RELEASE_ID.tar.gz" "$SERVER:$REMOTE_SRC/"

echo "== build on server =="
$SSH "$SERVER" "cd $REMOTE_SRC && tar xzf rag-src-$RELEASE_ID.tar.gz && docker build -t $IMAGE -f service/Dockerfile ."

echo "== activate =="
$SSH "$SERVER" "
  docker tag puer-rag-service:current puer-rag-service:rollback-$RELEASE_ID 2>/dev/null || true
  docker tag $IMAGE puer-rag-service:current
  cd /opt/puer-hub && RAG_TAG=current docker compose $COMPOSE_ARGS up -d rag-service
"

echo "== health (in-container: port is not published) =="
$SSH "$SERVER" "docker exec puer-hub-rag-service python -c \"import urllib.request;print(urllib.request.urlopen('http://localhost:8000/healthz').status)\""

echo "OK: rag-service $RELEASE_ID live (rollback tag: rollback-$RELEASE_ID)"
