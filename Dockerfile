FROM node:20-alpine

WORKDIR /app

# docker CLI + compose plugin 필요
RUN apk add --no-cache docker-cli docker-cli-compose

COPY package.json yarn.lock ./
RUN yarn install --production

COPY index.js pause-decision-guard.js package.json ./

CMD ["node", "index.js"]
