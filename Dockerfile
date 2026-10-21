FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg font-noto-cjk

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs && adduser nextjs nodejs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
# Tea-draft runner: scripts/auto-post.mjs imports TypeScript (../src/lib/tea-drafts/
# runner.ts + generated prisma client) and runs via `node --import tsx`. Standalone
# tracing omits tsx (runtime loader, not imported by server.js), so overlay the full
# node_modules from `deps` (built by `npm ci`, includes tsx + esbuild). Strict superset
# of the traced standalone subset -> server.js keeps resolving; tsx available to script.
COPY --from=deps /app/node_modules ./node_modules

COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/src/generated ./src/generated
COPY --from=builder /app/prisma ./prisma

# Create writable uploads directories.
# Two tiers (see src/lib/upload-storage.ts):
#   public/uploads/*  — served over HTTP
#   private/*         — never served; bind-mounted so it survives recreates
RUN mkdir -p \
      /app/public/uploads/forum \
      /app/public/uploads/videos \
      /app/public/uploads/sessions \
      /app/public/uploads/inventory \
      /app/public/uploads/tea \
      /app/public/uploads/avatars \
      /app/private/uploads-tmp \
      /app/private/videos-raw

# Placeholder .jpg so Next.js indexes .jpg in videos/ at build time
RUN touch /app/public/uploads/videos/.placeholder.jpg

# Install su-exec for privilege drop
RUN apk add --no-cache su-exec

# Entrypoint: fix volume permissions as root, then drop to nextjs.
# The private tier gets 0700 as well — "not web-served" should not mean
# "readable by every process on the host".
RUN printf '#!/bin/sh\nfor d in forum videos sessions inventory tea avatars; do\n  chown -R nextjs:nodejs /app/public/uploads/$d 2>/dev/null\ndone\nfor d in uploads-tmp videos-raw; do\n  chown -R nextjs:nodejs /app/private/$d 2>/dev/null\n  chmod 700 /app/private/$d 2>/dev/null\ndone\nexec su-exec nextjs "$@"\n' > /sbin/entrypoint.sh && chmod +x /sbin/entrypoint.sh

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["/sbin/entrypoint.sh"]
CMD ["node", "server.js"]
