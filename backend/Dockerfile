# Imagen única para todos los servicios: se elige el servicio con la variable SERVICE.
FROM node:22-alpine

ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY lib ./lib
COPY services ./services

RUN mkdir -p /data && chown -R node:node /data /app
USER node

ARG SERVICE
ENV SERVICE=${SERVICE}
CMD ["sh", "-c", "exec node services/${SERVICE}/index.js"]
