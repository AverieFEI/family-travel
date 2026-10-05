FROM node:20-alpine

WORKDIR /app

COPY family-travel-deploy/package.json ./
RUN npm install --omit=dev

COPY family-travel-deploy/ .

ENV PORT=8390
EXPOSE 8390

CMD ["node", "server.js"]
