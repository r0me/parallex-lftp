FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends lftp openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

ENV PORT=7609 \
    LOCAL_ROOT=/data \
    CONFIG_DIR=/config

EXPOSE 7609
VOLUME ["/data", "/config"]

CMD ["node", "server/index.js"]
