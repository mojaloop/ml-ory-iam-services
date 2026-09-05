import env from 'env-var';

export const config = {
  port: env.get('PORT').default('3002').asPortNumber(),
  ketoReadUrl: env.get('KETO_READ_URL').default('http://keto-read.ory.svc.cluster.local').asString(),
  /**
   * A caller whose visible set exceeds this is being granted by enumeration
   * where a group node or the type-wide object belongs. The scope is still
   * delivered whole, and the excess raises an alarm.
   */
  scopeAlarm: env.get('SCOPE_ALARM').default('500').asIntPositive(),
};
