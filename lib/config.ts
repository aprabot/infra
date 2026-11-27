import * as fs from 'fs';
import * as path from 'path';

/** The two environments. Each lives in its own AWS account (same organization)
 *  and has the same stacks; prod is the original, hand-built backend that was
 *  imported into CloudFormation. None of these values are secrets. */
export type StageName = 'prod' | 'beta';

export interface Stage {
  name: StageName;
  account: string;
  region: 'us-east-1';
  /** Site hostnames; the first is canonical, the others redirect to it. */
  domains: string[];
  /** ACM certificate (us-east-1) covering `domains`, issued by DNS validation. Empty until requested. */
  certificateArn: string;
  /** Assigned by AWS when the user pool is created. Empty for a stage whose data stack isn't deployed yet. */
  userPoolId: string;
  userPoolClientId: string;
  /** Keep the site out of search engines. */
  noindex: boolean;
  /** Two-step sign-in (authenticator app): required ("ON") or switched off ("OFF"). */
  mfa: 'ON' | 'OFF';
}

/** Everything a stage needs to know about itself is in stages.json, committed. */
const STAGES: Record<StageName, Stage> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'stages.json'), 'utf8'));

export function stage(name: string | undefined): Stage {
  const s = STAGES[(name ?? 'prod') as StageName];
  if (!s) throw new Error(`Unknown stage "${name}". Use -c stage=prod or -c stage=beta.`);
  return s;
}

export const isProd = (s: Stage) => s.name === 'prod';
export const env = (s: Stage) => ({ account: s.account, region: s.region });

/** Names are the same in every account; only the bucket carries the account number. */
export const tableName = 'aprabot-amplify';
export const queueName = 'amplify-sync-queue';
export const userPoolName = 'aprabot-users';
export const bucketName = (s: Stage) => `aprabot-forecast-${s.account}`;
export const siteBucketName = (s: Stage) => `aprabot-site-${s.account}`;
export const origins = (s: Stage) => s.domains.map(d => `https://${d}`);

export const arns = (s: Stage) => ({
  bucket: `arn:aws:s3:::${bucketName(s)}`,
  table: `arn:aws:dynamodb:${s.region}:${s.account}:table/${tableName}`,
  queue: `arn:aws:sqs:${s.region}:${s.account}:${queueName}`,
  userPool: `arn:aws:cognito-idp:${s.region}:${s.account}:userpool/${s.userPoolId}`,
  fn: (name: string) => `arn:aws:lambda:${s.region}:${s.account}:function:${name}`,
  secret: (pattern: string) => `arn:aws:secretsmanager:${s.region}:${s.account}:secret:${pattern}`,
});
export const queueUrl = (s: Stage) => `https://sqs.${s.region}.amazonaws.com/${s.account}/${queueName}`;

/** Ad-platform app identifiers (not secrets). Read from config.local.json
 *  locally, or from APRA_SHOPIFY_API_KEY / APRA_GOOGLE_OAUTH_CLIENT_ID in CI.
 *  Real secrets stay in Secrets Manager and never appear here. */
export interface LocalConfig { shopifyApiKey: string; googleOAuthClientId: string }

export function loadLocalConfig(): LocalConfig {
  const fromEnv = { shopifyApiKey: process.env.APRA_SHOPIFY_API_KEY, googleOAuthClientId: process.env.APRA_GOOGLE_OAUTH_CLIENT_ID };
  if (fromEnv.shopifyApiKey && fromEnv.googleOAuthClientId) return fromEnv as LocalConfig;
  const file = path.join(process.cwd(), 'config.local.json');
  if (!fs.existsSync(file)) throw new Error('config.local.json is missing. Run: npm run config');
  const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LocalConfig>;
  if (!c.shopifyApiKey || !c.googleOAuthClientId) throw new Error('config.local.json needs shopifyApiKey and googleOAuthClientId.');
  return c as LocalConfig;
}
