export interface Env {
  DB: D1Database;
  PROVISION_WORKFLOW: Workflow<WorkflowParams>;
  PUBLIC_BASE_URL: string;
  BOT_USERNAME: string;
  SING_BOX_VERSION: string;
  SESSION_TTL_SECONDS: string;
  LOGIN_LINK_TTL_SECONDS: string;
  BOOTSTRAP_TTL_SECONDS: string;
  API_TOKEN_TTL_SECONDS?: string;
  ADMIN_TELEGRAM_IDS: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
}

export type WorkflowParams =
  | { action: "prepare"; deploymentId: string }
  | { action: "finalize"; deploymentId: string }
  | { action: "revoke"; deploymentId: string };

export interface SessionPrincipal {
  tenantId: string;
  telegramUserId: string;
  displayName: string;
  isAdmin: boolean;
  sessionHash: string;
}

export interface DeploymentRow {
  id: string;
  tenant_id: string;
  oauth_connection_id: string;
  account_id: string;
  zone_id: string;
  worker_name: string;
  worker_hostname: string;
  node_hostname: string;
  vps_ipv4: string;
  acme_email: string;
  reality_server_name: string;
  enable_ufw: number;
  status: string;
  status_detail: string | null;
  workflow_instance_id: string | null;
  subscription_token_hash: string;
  agent_token_hash: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionRow {
  id: string;
  tenant_id: string;
  auth_type: "oauth" | "api_token";
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: string | null;
  scopes: string | null;
  cf_user_id: string | null;
  cf_email: string | null;
  resource_account_id: string | null;
  resource_account_name: string | null;
  resource_zone_id: string | null;
  resource_zone_name: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SecretBundle {
  subscriptionToken: string;
  vlessPort?: number;
  vlessUuid?: string;
  realityPublicKey?: string;
  realityShortId?: string;
  hysteria2Password?: string;
  hysteria2CertSha256?: string;
  hysteria2SpkiSha256?: string;
  nodeConfigSha256?: string;
}

export interface AgentCompletePayload {
  deploymentId: string;
  agentToken: string;
  singBoxVersion: string;
  vlessPort: number;
  vlessUuid: string;
  realityPublicKey: string;
  realityShortId: string;
  hysteria2Password: string;
  hysteria2CertSha256: string;
  hysteria2SpkiSha256: string;
  configSha256: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: {
      id: number;
      is_bot: boolean;
      first_name: string;
      last_name?: string;
      username?: string;
      language_code?: string;
    };
    text?: string;
  };
}
