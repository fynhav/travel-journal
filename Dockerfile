FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.html sw.js manifest.webmanifest icon-180.png icon-192.png icon-512.png ./
COPY vendor ./vendor
COPY server ./server
ENV PORT=3000
CMD ["node", "server/server.js"]
