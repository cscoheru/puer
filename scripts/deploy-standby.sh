#!/bin/bash
# deploy-standby.sh — Quick deploy Puêr to a new server
# Usage:  On a fresh Ubuntu server with Docker, run:
#   curl -sL https://puer.im/deploy-standby.sh | bash
# Or:
#   scp scripts/deploy-standby.sh root@NEW-IP:/root/ && ssh root@NEW-IP ./deploy-standby.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== Puêr Standby Deployment ===${NC}"

# ── Config ─────────────────────────────────────────────
DOMAIN="puer.im"
PG_USER="puerhub"
PG_DB="puerhub"
PG_PASS="${DB_PASSWORD:-TeaHub2026Secure}"
AUTH_SECRET="${AUTH_SECRET:-puer-hub-prod-change-me}"
DEEPSEEK_KEY="${DEEPSEEK_API_KEY:-}"

# ── Prerequisites ──────────────────────────────────────
echo -e "${YELLOW}[1/5] Checking prerequisites...${NC}"
command -v docker >/dev/null 2>&1 || { echo -e "${RED}Docker not found. Install: curl -fsSL https://get.docker.com | bash${NC}"; exit 1; }
command -v docker compose >/dev/null 2>&1 || { echo -e "${RED}docker compose not found${NC}"; exit 1; }

# ── Directory setup ────────────────────────────────────
echo -e "${YELLOW}[2/5] Setting up directories...${NC}"
mkdir -p /opt/puer-hub/{backups/db,uploads/{forum,inventory,videos}}

# ── Docker Compose ─────────────────────────────────────
echo -e "${YELLOW}[3/5] Writing docker-compose.yml...${NC}"
cat > /opt/puer-hub/docker-compose.yml << 'DOCKERCOMPOSE'
version: "3.8"

services:
  postgres:
    image: postgres:16-alpine
    container_name: puer-hub-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: puerhub
      POSTGRES_PASSWORD: ${DB_PASSWORD:-TeaHub2026Secure}
      POSTGRES_DB: puerhub
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - puer-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U puerhub"]
      interval: 5s
      timeout: 5s
      retries: 5

  app:
    image: cscoheru/puer-hub-app:latest
    container_name: puer-hub-app
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://puerhub:${DB_PASSWORD:-TeaHub2026Secure}@postgres:5432/puerhub
      AUTH_SECRET: ${AUTH_SECRET:-puer-hub-prod-change-me}
      AUTH_URL: https://puer.im
      NEXT_PUBLIC_APP_URL: https://puer.im
      NEXT_PUBLIC_WS_URL: wss://puer.im
      NEXT_PUBLIC_GOOGLE_VERIFICATION: ${GOOGLE_VERIFICATION:-}
    volumes:
      - /opt/puer-hub/uploads:/app/public/uploads:ro
    networks:
      - puer-net
    ports:
      - "3002:3000"

  ws-server:
    image: cscoheru/puer-hub-ws-server:latest
    container_name: puer-hub-ws
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://puerhub:${DB_PASSWORD:-TeaHub2026Secure}@postgres:5432/puerhub
      AUTH_SECRET: ${AUTH_SECRET:-puer-hub-prod-change-me}
      CORS_ORIGIN: https://puer.im
      WS_PORT: "3011"
    networks:
      - puer-net

networks:
  puer-net:
    driver: bridge

volumes:
  pgdata:
DOCKERCOMPOSE

# ── Restore from backup ────────────────────────────────
echo -e "${YELLOW}[4/5] Restoring database...${NC}"
# Need the latest backup file - provide via URL or scp
if [ -f /tmp/latest-db.sql.gz ]; then
  docker compose -f /opt/puer-hub/docker-compose.yml up -d postgres
  echo "Waiting for PostgreSQL..."
  sleep 10
  gunzip -c /tmp/latest-db.sql.gz | docker compose -f /opt/puer-hub/docker-compose.yml exec -T postgres psql -U puerhub puerhub
  echo -e "${GREEN}Database restored${NC}"
else
  echo -e "${YELLOW}No backup file found at /tmp/latest-db.sql.gz${NC}"
  echo "You can restore later by:"
  echo "  scp backup.sql.gz root@NEW-IP:/tmp/latest-db.sql.gz"
  echo "  then run the restore step manually"
fi

# ── Start services ─────────────────────────────────────
echo -e "${YELLOW}[5/5] Starting services...${NC}"
docker compose -f /opt/puer-hub/docker-compose.yml up -d app ws-server

echo -e "${GREEN}=== Deployment complete ===${NC}"
echo "App running at http://localhost:3002"
echo ""
echo "Next steps:"
echo "1. Update DNS A record to point to this server's IP"
echo "2. Set up nginx to proxy to :3002 (see docs/nginx.conf)"
echo "3. Run certbot for SSL: certbot certonly --standalone -d puer.im -d www.puer.im"
echo "4. Sync uploads: rsync -avz root@OLD_IP:/opt/puer-hub/uploads/ /opt/puer-hub/uploads/"
