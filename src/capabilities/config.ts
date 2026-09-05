import env from 'env-var';

export const config = {
  port: env.get('PORT').default('3001').asPortNumber(),
  ketoReadUrl: env.get('KETO_READ_URL').default('http://keto-read.ory.svc.cluster.local').asString(),
  subjectHeader: env.get('SUBJECT_HEADER').default('x-user').asString(),
};
