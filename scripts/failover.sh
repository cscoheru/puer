#!/bin/bash
# failover.sh — Promote standby to primary and start app on old HK server
# Run this on the STANDBY server (103.59.103.85) when main server is down
#
# Usage: ssh root@103.59.103.85 'bash -s' < failover.sh
# Or:    ssh aliyun "ssh root@103.59.103.85 'bash -s'" < failover.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== Puêr Failover — Promoting Standby ===${NC}"

# ── Step 1: Check connectivity to main ────────────────
echo -e "${YELLOW}[1/6] Checking main server...${NC}"
if ping -c 1 -W 2 207.57.134.99 >/dev/null 2>&1; then
  echo -e "${RED}Main server (207.57.134.99) is still reachable!${NC}"
  echo "Use this script only when main is confirmed down."
  exit 1
fi
echo "Main server unreachable — proceeding with failover."

# ── Step 2: Promote standby PostgreSQL ─────────────────
echo -e "${YELLOW}[2/6] Promoting standby database to primary...${NC}"
su - postgres -c "psql -U puerhub -d puerhub -c 'SELECT pg_wal_replay_resume();' 2>/dev/null || true"
su - postgres -c "pg_ctl promote -D /var/lib/postgresql/16/main" 2>/dev/null || \
  pg_ctlcluster 16 main promote
echo -e "${GREEN}  Database promoted to primary${NC}"

# ── Step 3: Sync uploads from main (best effort) ──────
echo -e "${YELLOW}[3/6] Syncing uploads (if main is partially reachable)...${NC}"
mkdir -p /opt/puer-hub/uploads/{forum,inventory,videos}
rsync -avz --timeout=10 root@207.57.134.99:/opt/puer-hub/uploads/ /opt/puer-hub/uploads/ 2>/dev/null && \
  echo -e "${GREEN}  Uploads synced${NC}" || \
  echo -e "${YELLOW}  Main unreachable, using last known state${NC}"

# ── Step 4: Create docker-compose.yml ─────────────────
echo -e "${YELLOW}[4/6] Setting up Docker services...${NC}"
mkdir -p /opt/puer-hub

# Use the standby DB (now primary) directly via host socket
cat > /opt/puer-hub/docker-compose.yml << 'DOCKERCOMPOSE'
services:
  app:
    image: cscoheru/puer-hub-app:latest
    container_name: puer-hub-app
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://puerhub:TeaHub2026Secure@127.0.0.1:5432/puerhub
      AUTH_SECRET: ${AUTH_SECRET:-puer-hub-prod-change-me}
      AUTH_URL: https://puer.im
      NEXT_PUBLIC_APP_URL: https://puer.im
      NEXT_PUBLIC_WS_URL: wss://puer.im
    volumes:
      - /opt/puer-hub/uploads:/app/public/uploads:ro
    ports:
      - "3002:3000"

  ws-server:
    image: cscoheru/puer-hub-ws-server:latest
    container_name: puer-hub-ws
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://puerhub:TeaHub2026Secure@127.0.0.1:5432/puerhub
      AUTH_SECRET: ${AUTH_SECRET:-puer-hub-prod-change-me}
      CORS_ORIGIN: https://puer.im
      WS_PORT: "3011"
    ports:
      - "3011:3011"
DOCKERCOMPOSE

# Images are pre-loaded from main server backup (saved in /tmp/)
if docker images puer-hub-app:latest | grep -q puer-hub-app; then
  echo -e "${GREEN}  Images found locally${NC}"
else
  echo -e "${YELLOW}  Images not found — check /tmp/puer-*-image.tar or build from source${NC}"
fi

# ── Step 5: Start services ────────────────────────────
echo -e "${YELLOW}[5/6] Starting services...${NC}"
cd /opt/puer-hub && docker compose up -d 2>&1 | tail -3

# ── Step 6: Update DNS ────────────────────────────────
echo -e "${YELLOW}[6/6] DNS update instructions:${NC}"
echo ""
echo -e "${GREEN}=== App should be running at http://localhost:3002 ===${NC}"
echo ""
echo "To make the site live:"
echo "1. Go to Cloudflare Dashboard → DNS → puer.im"
echo "2. Change the A record from 207.57.134.99 to 103.59.103.85"
echo "3. TTL: 60 seconds (or 5 min auto if orange cloud)"
echo "4. Set up nginx + SSL: ssh into this server and run:"
echo ""
echo "   apt-get install -y nginx certbot python3-certbot-nginx"
echo "   cat > /etc/nginx/sites-enabled/puer << 'EOF'"
echo "   server {"
echo "       server_name puer.im www.puer.im;"
echo "       location / {"
echo "           proxy_pass http://127.0.0.1:3002;"
echo "           proxy_set_header Host \$host;"
echo "           proxy_set_header X-Real-IP \$remote_addr;"
echo "           proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;"
echo "           proxy_set_header X-Forwarded-Proto \$scheme;"
echo "       }"
echo "       location /ws {"
echo "           proxy_pass http://127.0.0.1:3011;"
echo "           proxy_http_version 1.1;"
echo "           proxy_set_header Upgrade \$http_upgrade;"
echo "           proxy_set_header Connection \"upgrade\";"
echo "       }"
echo "       listen 80;"
echo "   }"
echo "   EOF"
echo "   certbot --nginx -d puer.im -d www.puer.im"
echo ""
echo -e "${YELLOW}Note: After main server recovers, you need to:${NC}"
echo "1. Stop the app on the standby (docker compose down)"
echo "2. Switch DNS back to 207.57.134.99"
echo "3. Rebuild replication: rm -rf /var/lib/postgresql/16/main/* && pg_basebackup -h MAIN_IP -U replicator -D /var/lib/postgresql/16/main -P -R"
echo "4. Start standby: systemctl start postgresql"
