import { Configuration, CourierApi, FrontendApi, IdentityApi } from '@ory/client';

/** What the courier's record says about invitations to an address. */
export type InvitationState = 'delivered' | 'sending' | 'none';

const INVITATION_TEMPLATES = ['recovery_valid', 'recovery_code_valid'];

/** Kratos' APIs, for the one identity a fresh deployment needs. */
export class KratosAdmin {
  private readonly identities: IdentityApi;
  private readonly courier: CourierApi;
  private readonly frontend?: FrontendApi;

  constructor(adminUrl: string, publicUrl?: string) {
    this.identities = new IdentityApi(new Configuration({ basePath: adminUrl }));
    this.courier = new CourierApi(new Configuration({ basePath: adminUrl }));
    if (publicUrl !== undefined) {
      this.frontend = new FrontendApi(new Configuration({ basePath: publicUrl }));
    }
  }

  async findByEmail(email: string): Promise<string | undefined> {
    const { data } = await this.identities.listIdentities({ credentialsIdentifier: email });
    return data[0]?.id;
  }

  async create(email: string, password?: string): Promise<string> {
    const { data } = await this.identities.createIdentity({
      createIdentityBody: {
        schema_id: 'default',
        traits: { email },
        ...(password !== undefined ? { credentials: { password: { config: { password } } } } : {}),
        verifiable_addresses: [{ value: email, via: 'email', verified: true, status: 'completed' }],
      },
    });
    return data.id;
  }

  async findOrCreate(email: string, password?: string): Promise<{ id: string; created: boolean }> {
    const existing = await this.findByEmail(email);
    if (existing !== undefined) return { id: existing, created: false };
    return { id: await this.create(email, password), created: true };
  }

  /**
   * Kratos marks a message sent once the mail server has taken it, keeps the
   * record afterwards, and returns a message it could not hand over to the
   * queue until it either goes out or is abandoned.
   */
  async invitationState(email: string): Promise<InvitationState> {
    const { data } = await this.courier.listCourierMessages({ recipient: email, pageSize: 250 });
    const invitations = data.filter((message) => INVITATION_TEMPLATES.includes(message.template_type));
    if (invitations.some((message) => message.status === 'sent')) return 'delivered';
    if (invitations.some((message) => message.status === 'queued' || message.status === 'processing')) return 'sending';
    return 'none';
  }

  /**
   * A self-service recovery flow for the identity: the courier emails a
   * one-time link, and clicking it signs the holder in to set a password.
   */
  async invite(email: string): Promise<void> {
    if (this.frontend === undefined) throw new Error(`no Kratos public URL to invite ${email} through`);
    const { data: flow } = await this.frontend.createNativeRecoveryFlow();
    await this.frontend.updateRecoveryFlow({
      flow: flow.id,
      updateRecoveryFlowBody: { method: 'link', email },
    });
  }
}
