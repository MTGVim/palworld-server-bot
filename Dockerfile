FROM node:20-alpine

WORKDIR /app
ARG BUILD_COMMIT_AT=unknown
ENV BUILD_COMMIT_AT=$BUILD_COMMIT_AT

# docker CLI 필요
RUN apk add --no-cache docker-cli

COPY package.json yarn.lock ./
RUN yarn install --production

COPY index.js pause-decision-guard.js package.json ./

CMD ["node", "index.js"]
