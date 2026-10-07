FROM node:22-bookworm-slim
ARG APP_VERSION=dev
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY bin ./bin
ENV NODE_ENV=production APP_VERSION=$APP_VERSION
CMD ["node", "src/index.ts"]
