# Dockerfile per WhatsApp Proxy Server
FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS dependencies
WORKDIR /build
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

# Baileys uses native/prebuilt Node modules; no Chromium runtime is required.
RUN apk upgrade --no-cache && apk add --no-cache su-exec
# Runtime starts Node directly and does not need package-manager executables.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack

# Crea directory dell'applicazione
WORKDIR /app

# Copia package.json e package-lock.json (se presente)
COPY package*.json ./

# Installa le dipendenze
COPY --from=dependencies /build/node_modules ./node_modules

# Copia il codice sorgente (escludendo node_modules e file non necessari)
COPY src ./src
COPY config ./config
COPY config/config.ini ./default-config.ini
COPY index.js ./
COPY README.md LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses

# Crea directory (ownership definitiva assegnata nell'entrypoint)
RUN mkdir -p data/auth data/logs

# Copia entrypoint
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Esponi la porta
EXPOSE 3000

# Entry & default cmd
ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "index.js"]
