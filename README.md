# Mojaloop Ory IAM Services

This repository contains Ory IAM integration services for Mojaloop:

- **keto-batch-auth** - Proxy for Keto batch authorization checks
- **kratos-role-webhook** - Webhook to inject roles into Kratos identities

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run a service
npm start keto-batch-auth
npm start kratos-role-webhook

# Show help
npm start -- --help
```

## Services

### keto-batch-auth

Proxy service for Keto's batch authorization check API. Returns 200 if any permission is allowed, 403 otherwise.

**Environment Variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `KETO_READ_URL` | `http://keto-read.ory.svc.cluster.local` | Keto read API URL |

**Endpoints:**
- `GET /health` - Health check
- `POST /` - Batch authorization check (proxies to Keto)

### kratos-role-webhook

Webhook service that injects user roles from Keto into Kratos identity traits.

**Environment Variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `KRATOS_ADMIN_URL` | `http://kratos-admin` | Kratos admin API URL |
| `KETO_READ_URL` | `http://keto-read` | Keto read API URL |

**Endpoints:**
- `GET /health` - Health check
- `POST /inject-roles` - Inject roles into identity

## Docker

```bash
# Build
docker build -t mojaloop/ml-ory-iam-services .

# Run keto-batch-auth
docker run -p 3000:3000 mojaloop/ml-ory-iam-services keto-batch-auth

# Run kratos-role-webhook
docker run -p 8080:8080 mojaloop/ml-ory-iam-services kratos-role-webhook
```

## Development

```bash
# Run tests
npm test

# Run linter
npm run lint

# Run in development mode
npm run start:dev keto-batch-auth
```

## Helm Chart

The Helm chart is available at [mojaloop/helm/ory-services](https://github.com/mojaloop/helm/tree/main/ory-services).

## License

Apache-2.0
