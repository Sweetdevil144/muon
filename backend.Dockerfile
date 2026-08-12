# Backend image built from the repo root so the embedded graph package
# (@muon/graph -> packages/graph) is inside the build context.
# Debian (not Alpine): @ladybugdb/core ships glibc prebuilt binaries.
FROM node:20-slim

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

COPY packages/protocol/package*.json ./packages/protocol/
RUN cd packages/protocol && npm ci

COPY packages/protocol ./packages/protocol
RUN cd packages/protocol && npm run build

COPY packages/graph/package*.json ./packages/graph/
RUN cd packages/graph && npm ci

COPY packages/graph ./packages/graph
RUN cd packages/graph && npm run build

COPY backend/package*.json ./backend/
RUN cd backend && npm ci

# file: deps resolve after the workspace packages exist, reinstall links.
COPY backend ./backend
RUN cd backend && npm install --no-audit --no-fund \
  && npx prisma generate && npm run build

ENV NODE_ENV=production
WORKDIR /repo/backend
EXPOSE 4000

CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run start"]
