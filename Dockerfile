FROM node:20-slim

# links the GHCR package to this repository on its packages page
LABEL org.opencontainers.image.source=https://github.com/r0me/parallex-lftp \
      org.opencontainers.image.description="Dual-pane web file browser backed by lftp (FTP/FTPS/SFTP) with segmented parallel downloads" \
      org.opencontainers.image.licenses=MIT

RUN apt-get update \
    && apt-get install -y --no-install-recommends lftp openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV PORT=7609 \
    LOCAL_ROOT=/data \
    CONFIG_DIR=/config \
    PUID=1000 \
    PGID=1000 \
    UMASK=022

EXPOSE 7609
VOLUME ["/data", "/config"]

ENTRYPOINT ["./entrypoint.sh"]
