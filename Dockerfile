# Arguments
ARG NODE_VERSION=22-alpine

# Build stage
FROM node:${NODE_VERSION} AS builder
WORKDIR /opt/app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Production stage
FROM node:${NODE_VERSION}
WORKDIR /opt/app

COPY package*.json ./
RUN npm ci --omit=dev

# Create a non-root user
RUN adduser -D app-user
USER app-user

COPY --chown=app-user --from=builder /opt/app/dist ./dist

EXPOSE 3000 8080

ENTRYPOINT ["node", "./dist/cli.js"]
CMD ["--help"]
