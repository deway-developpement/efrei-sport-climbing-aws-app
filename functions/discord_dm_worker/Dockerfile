FROM node:22-alpine

WORKDIR /app

COPY functions/discord_dm_worker/package*.json /app/functions/discord_dm_worker/

WORKDIR /app/functions/discord_dm_worker
RUN npm ci

WORKDIR /app
COPY layers/commons /app/layers/commons
COPY functions/discord_dm_worker /app/functions/discord_dm_worker

WORKDIR /app/functions/discord_dm_worker
RUN npm run build

CMD ["npm", "run", "start"]
