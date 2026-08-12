# glibc (Debian) base, NOT Alpine/musl. The embedded graph (@ladybugdb/core)
# ships only glibc prebuilt native binaries (linux-x64 / linux-arm64, no -musl
# variant and no musl detection in its installer), so on Alpine it loads a
# glibc .node on musl and SEGFAULTS at the first graph call. Debian's glibc is
# what its prebuilt expects.
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS builder
WORKDIR /app
COPY prisma ./prisma
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests
RUN npm run prisma:generate && npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Prisma's query engine needs OpenSSL at runtime; node:20-slim omits it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY package*.json ./
EXPOSE 4000
CMD ["sh", "-c", "npx prisma db push && npm run start"]
