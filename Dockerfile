FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
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
