FROM node:22-alpine
WORKDIR /app
COPY tests/mock-integrations.mjs .
USER node
CMD ["node","mock-integrations.mjs"]
