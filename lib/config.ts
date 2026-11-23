import * as fs from 'fs';
import * as path from 'path';

/** Identifiers of the one live environment. None of these are secrets. */
export const env = { account: '751835847089', region: 'us-east-1' };
export const bucketName = `aprabot-forecast-${env.account}`;
export const tableName = 'aprabot-amplify';
export const queueName = 'amplify-sync-queue';
export const userPoolName = 'aprabot-users';
/** Assigned by AWS; update both if the pool is ever recreated (homepage's js/auth.js uses them too). */
export const userPoolId = 'us-east-1_fb34nECGY';
export const userPoolClientId = '5g9h8366bt5j8el588eh3lh5n4';

export const arn = {
  bucket: `arn:aws:s3:::${bucketName}`,
  table: `arn:aws:dynamodb:${env.region}:${env.account}:table/${tableName}`,
  queue: `arn:aws:sqs:${env.region}:${env.account}:${queueName}`,
  userPool: `arn:aws:cognito-idp:${env.region}:${env.account}:userpool/${userPoolId}`,
  fn: (name: string) => `arn:aws:lambda:${env.region}:${env.account}:function:${name}`,
  secret: (pattern: string) => `arn:aws:secretsmanager:${env.region}:${env.account}:secret:${pattern}`,
};
export const queueUrl = `https://sqs.${env.region}.amazonaws.com/${env.account}/${queueName}`;

/** Ad-platform app identifiers. Kept out of git, in the ignored
 *  config.local.json (`npm run config` writes it from the live
 *  Lambda). Real secrets stay in Secrets Manager and never appear here. */
export interface LocalConfig { shopifyApiKey: string; googleOAuthClientId: string }

export function loadLocalConfig(): LocalConfig {
  const file = path.join(process.cwd(), 'config.local.json');
  if (!fs.existsSync(file)) throw new Error('config.local.json is missing. Run: npm run config');
  const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LocalConfig>;
  if (!c.shopifyApiKey || !c.googleOAuthClientId) throw new Error('config.local.json needs shopifyApiKey and googleOAuthClientId.');
  return c as LocalConfig;
}
