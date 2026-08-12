FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS builder
WORKDIR /app
COPY . .
ARG NEXT_PUBLIC_MUON_API_BASE=http://localhost:4000
ARG MUON_API_BASE=http://localhost:4000
ENV NEXT_PUBLIC_MUON_API_BASE=${NEXT_PUBLIC_MUON_API_BASE}
ENV MUON_API_BASE=${MUON_API_BASE}
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package*.json ./
EXPOSE 3050
ENV PORT=3050
# MUON_API_TOKEN is injected at runtime (never baked into the image).
CMD ["npm", "run", "start"]
