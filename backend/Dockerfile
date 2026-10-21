FROM node:22-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev
COPY approvals-ui/ /app/approvals-ui/
USER node
CMD ["npm","start"]
