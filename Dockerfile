FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build
RUN pnpm run build

# Prune dev dependencies
RUN pnpm prune --prod

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
