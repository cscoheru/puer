#!/bin/bash
# sync-images-to-standby.sh
# Sync Docker images from main server to standby server
# Run on the MAIN server after deployments, or via cron
#
# Network: Main HK → (saves .tar) → aliyun bridge → Old HK (docker load)

set -euo pipefail

MAIN_APP_IMAGE="puer-hub-app:latest"
MAIN_WS_IMAGE="puer-hub-ws-server:latest"
STANDBY_HOST="root@103.59.103.85"
BACKUP_DIR="/opt/puer-hub/backups/images"

echo "=== Syncing Docker images to standby ==="
echo "App image: $MAIN_APP_IMAGE"
echo "WS image:  $MAIN_WS_IMAGE"
echo ""

# Step 1: Save images
echo "[1/4] Saving images..."
mkdir -p "$BACKUP_DIR"
docker save "$MAIN_APP_IMAGE" -o "$BACKUP_DIR/puer-app.tar"
docker save "$MAIN_WS_IMAGE" -o "$BACKUP_DIR/puer-ws.tar"
echo "  Images saved to $BACKUP_DIR"

# Step 2: SCP to aliyun bridge
echo "[2/4] Transferring to aliyun bridge..."
scp -o StrictHostKeyChecking=no "$BACKUP_DIR/puer-app.tar" root@139.224.42.111:/root/puer-app.tar
scp -o StrictHostKeyChecking=no "$BACKUP_DIR/puer-ws.tar" root@139.224.42.111:/root/puer-ws.tar
echo "  Transferred"

# Step 3: Bridge → Old HK
echo "[3/4] Transferring from aliyun to standby..."
ssh -o StrictHostKeyChecking=no root@139.224.42.111 \
  "scp -o StrictHostKeyChecking=no /root/puer-app.tar $STANDBY_HOST:/tmp/puer-app.tar && \
   scp -o StrictHostKeyChecking=no /root/puer-ws.tar $STANDBY_HOST:/tmp/puer-ws.tar && \
   rm -f /root/puer-app.tar /root/puer-ws.tar"
echo "  Delivered to standby"

# Step 4: Load on standby
echo "[4/4] Loading images on standby..."
ssh -o StrictHostKeyChecking=no root@139.224.42.111 \
  "ssh -o StrictHostKeyChecking=no $STANDBY_HOST 'docker load -i /tmp/puer-app.tar && docker load -i /tmp/puer-ws.tar && rm -f /tmp/puer-app.tar /tmp/puer-ws.tar'"
echo ""
echo "=== Sync complete ==="
