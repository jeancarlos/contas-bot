FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
ARG APP_VERSION=dev
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json CHANGELOG.jso[n] ./
RUN npm ci --omit=dev --ignore-scripts && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY src ./src
COPY bin ./bin
ENV NODE_ENV=production APP_VERSION=$APP_VERSION
USER node
CMD ["node", "src/shell/index.ts"]
