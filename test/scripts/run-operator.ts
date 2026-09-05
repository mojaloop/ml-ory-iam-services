import { Operator } from '../../src/operator/server';

/**
 * Runs the reconciler against whatever cluster the current kubeconfig points
 * at, for watching it work on a real API server.
 *
 *   KUBECONFIG=… npx tsx test/scripts/run-operator.ts mojaloop authz-published
 */
const [namespace = 'mojaloop', publishAs = 'authz-published'] = process.argv.slice(2);

const operator = new Operator({
  namespace,
  publishAs,
  onAccepted: (result) => {
    console.log(
      JSON.stringify({
        event: 'accepted',
        services: result.composition?.catalog.map((c) => c.service),
        origins: result.origins,
      }),
    );
  },
});

operator
  .start()
  .then((first) => {
    console.log(JSON.stringify({ event: 'started', problems: first.problems, origins: first.origins }));
  })
  .catch((error) => {
    console.error(JSON.stringify({ event: 'failed', error: (error as Error).message }));
    process.exit(1);
  });

process.on('SIGINT', () => {
  operator.stop();
  process.exit(0);
});
