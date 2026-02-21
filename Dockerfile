FROM node:20-alpine

WORKDIR /app

# docker CLI 필요
RUN apk add --no-cache docker-cli

COPY package.json yarn.lock ./
RUN yarn install --production

COPY index.js idle-warning-decision.js rps-core.js package.json ./

CMD ["node", "index.js"]
