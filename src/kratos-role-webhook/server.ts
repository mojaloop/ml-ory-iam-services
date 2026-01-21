import { createServer } from 'node:http';
import { config } from './config';
import { handleRequest, getUserRoles, updateIdentityRoles } from './handler';

export const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('Unhandled error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });
});

server.listen(config.port, () => {
  console.log(`Kratos role webhook listening on port ${config.port}`);
  console.log(`Kratos admin URL: ${config.kratosAdminUrl}`);
  console.log(`Keto read URL: ${config.ketoReadUrl}`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down...');
  server.close(() => {
    process.exit(0);
  });
});

export { handleRequest, getUserRoles, updateIdentityRoles };
