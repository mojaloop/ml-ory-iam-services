import env from 'env-var';

export const config = {
  port: env.get('PORT').default('8080').asPortNumber(),
  kratosAdminUrl: env.get('KRATOS_ADMIN_URL').default('http://kratos-admin').asString(),
  ketoReadUrl: env.get('KETO_READ_URL').default('http://keto-read').asString(),
};
