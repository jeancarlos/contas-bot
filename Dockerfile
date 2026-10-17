FROM node:23-bookworm-slim@sha256:86191b94d2a163be41f3dc7fe5e5fcaca8ba2f1be7275d98a06343483c17414a
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
