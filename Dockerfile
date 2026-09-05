# Arguments
ARG NODE_VERSION=24.19.0-alpine3.24

# Build stage
FROM node:${NODE_VERSION} AS builder
WORKDIR /opt/app

COPY package*.json tsconfig.json ./
# The authz contract is published from here, so it is installed from the tree
# rather than the registry and has to be present before the install resolves it
COPY packages ./packages
RUN npm ci

COPY src ./src
RUN npm run build

# Production stage
FROM node:${NODE_VERSION}
WORKDIR /opt/app

COPY package*.json ./
COPY packages ./packages
RUN npm ci --omit=dev

# Create a non-root user
RUN adduser -D app-user
USER app-user

COPY --chown=app-user --from=builder /opt/app/dist ./dist
COPY --chown=app-user --from=builder /opt/app/src/iam/api.yaml ./src/iam/api.yaml

EXPOSE 3000 3001 8080

ENTRYPOINT ["node", "./dist/cli.js"]
CMD ["--help"]
