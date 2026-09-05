import env from 'env-var';

export const config = {
  port: env.get('PORT').default('3003').asPortNumber(),
  ketoWriteUrl: env.get('KETO_WRITE_URL').default('http://keto-write.ory.svc.cluster.local').asString(),
  ketoReadUrl: env.get('KETO_READ_URL').default('http://keto-read.ory.svc.cluster.local').asString(),
  /** How often each declared resource source is read into the registry. */
  sourceSyncSeconds: env.get('SOURCE_SYNC_SECONDS').default('60').asIntPositive(),
};
