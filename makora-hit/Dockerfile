# Image de production de MAKORA HIT.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/makora.db \
    UPLOAD_DIR=/data/uploads

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

# Les données (base SQLite + pièces jointes) vivent dans un volume, hors de l'image.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/setup" > /dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
