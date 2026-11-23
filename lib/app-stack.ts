import * as fs from 'fs';
import * as path from 'path';
import { Stack, StackProps, RemovalPolicy, CfnResource, Fn } from 'aws-cdk-lib';
import { CfnRole } from 'aws-cdk-lib/aws-iam';
import { CfnFunction, CfnPermission, CfnEventSourceMapping } from 'aws-cdk-lib/aws-lambda';
import { CfnApi, CfnAuthorizer, CfnIntegration, CfnRoute, CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { arn, bucketName, env, LocalConfig, queueUrl, tableName, userPoolClientId, userPoolId } from './config';

type Statement = { Effect: 'Allow'; Action: string[]; Resource: string | string[]; Condition?: object };
const allow = (Action: string[], Resource: string | string[], Condition?: object): Statement =>
  ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) });
const s3 = (...keys: string[]) => keys.map(k => `${arn.bucket}/${k}`);

/** Lambdas share three execution roles, as they do today. */
const ROLES: Record<string, { name: string; policies: Record<string, Statement[]> }> = {
  ForecastRole: { name: 'aprabot-forecast-lambda-role', policies: {
    'bedrock-invoke': [allow(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], '*')],
    'invoke-scenarios-api': [allow(['lambda:InvokeFunction'], arn.fn('aprabot-scenarios-api'))],
    's3-forecast-read': [allow(['s3:GetObject'], s3('forecast/*', 'insights/*', 'scenarios/*',
      'orgs/*/forecast/*', 'orgs/*/insights/*', 'orgs/*/scenarios/*'))],
    's3-insights-write': [allow(['s3:PutObject'], s3('orgs/*/insights/*'))],
    's3-knowledge-readwrite': [allow(['s3:GetObject', 's3:PutObject'], s3('knowledge/*'))],
  } },
  ScenarioRole: { name: 'aprabot-scenario-lambda-role', policies: {
    'amplify-campaigns-read': [allow(['dynamodb:Query', 'dynamodb:GetItem'], arn.table)],
    'cognito-list-users': [allow(['cognito-idp:ListUsers'], arn.userPool)],
    'invoke-runner': [allow(['lambda:InvokeFunction'],
      ['aprabot-scenario-runner', 'aprabot-explain-runner', 'aprabot-chat-api'].map(arn.fn))],
    'scenario-s3-access': [
      allow(['s3:ListBucket'], arn.bucket),
      allow(['s3:GetObject'], s3('raw/*', 'orgs/*/raw/*')),
      allow(['s3:GetObject', 's3:PutObject'], s3('scenarios/*', 'orgs/*/scenarios/*')),
      allow(['s3:GetObject', 's3:PutObject'], s3('forecast/*', 'orgs/*/forecast/*')),
      allow(['s3:GetObject', 's3:PutObject'], s3('uploads/*', 'orgs/*/uploads/*')),
      allow(['s3:GetObject', 's3:PutObject'], s3('orgs/*/support/*')),
    ],
  } },
  AmplifyRole: { name: 'aprabot-amplify-lambda-role', policies: {
    'amplify-campaigns-self-invoke': [allow(['lambda:InvokeFunction'], arn.fn('aprabot-amplify-campaigns'))],
    'amplify-campaigns-shopify-token-read': [allow(['secretsmanager:GetSecretValue'], arn.secret('amplify/*/shopify/*'))],
    'amplify-dynamodb-access': [allow(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
      'dynamodb:DeleteItem', 'dynamodb:Query'], [arn.table, `${arn.table}/index/*`])],
    'amplify-forecast-read': [allow(['s3:GetObject'], `${arn.bucket}/orgs/*/forecast/*`)],
    'amplify-s3-access': [
      allow(['s3:ListBucket'], arn.bucket, { StringLike: { 's3:prefix': 'orgs/*/amplify/*' } }),
      allow(['s3:GetObject', 's3:PutObject'], `${arn.bucket}/orgs/*/amplify/*`),
    ],
    'amplify-secrets-access': [allow(['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue',
      'secretsmanager:CreateSecret', 'secretsmanager:UpdateSecret', 'secretsmanager:DeleteSecret'], arn.secret('amplify/*'))],
    'amplify-sqs-access': [allow(['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage',
      'sqs:GetQueueAttributes'], arn.queue)],
  } },
};

type FnSpec = { role: keyof typeof ROLES; memory: number; timeout: number; tmp?: number; env: Record<string, string> };
const functions = (local: LocalConfig): Record<string, FnSpec> => ({
  'forecast-api': { role: 'ForecastRole', memory: 128, timeout: 10,
    env: { BUCKET_NAME: bucketName, FORECAST_KEY: 'forecast/latest.json' } },
  'insights-api': { role: 'ForecastRole', memory: 128, timeout: 10,
    env: { BUCKET_NAME: bucketName, INSIGHTS_KEY: 'insights/latest.json' } },
  'chat-api': { role: 'ForecastRole', memory: 256, timeout: 30, env: { BUCKET_NAME: bucketName,
    FORECAST_KEY: 'forecast/latest.json', MODEL_ID: 'amazon.nova-lite-v1:0', BEDROCK_REGION: 'us-west-2' } },
  'scenarios-api': { role: 'ScenarioRole', memory: 256, timeout: 15,
    env: { BUCKET_NAME: bucketName, RUNNER_FUNCTION: 'aprabot-scenario-runner' } },
  'scenario-runner': { role: 'ScenarioRole', memory: 3008, timeout: 900, tmp: 1024,
    env: { BUCKET_NAME: bucketName, LD_LIBRARY_PATH: '/var/task/lib', AMPLIFY_TABLE_NAME: tableName } },
  'explain-runner': { role: 'ScenarioRole', memory: 3008, timeout: 900, tmp: 1024,
    env: { BUCKET_NAME: bucketName, LD_LIBRARY_PATH: '/var/task/lib' } },
  'amplify-oauth': { role: 'AmplifyRole', memory: 256, timeout: 30, env: { TABLE_NAME: tableName, BUCKET_NAME: bucketName,
    GOOGLE_OAUTH_CLIENT_ID: local.googleOAuthClientId, SHOPIFY_API_KEY: local.shopifyApiKey } },
  'amplify-campaigns': { role: 'AmplifyRole', memory: 256, timeout: 300, env: { TABLE_NAME: tableName, BUCKET_NAME: bucketName } },
  'amplify-sync-dispatcher': { role: 'AmplifyRole', memory: 256, timeout: 60,
    env: { TABLE_NAME: tableName, SYNC_QUEUE_URL: queueUrl } },
  'amplify-sync-worker': { role: 'AmplifyRole', memory: 256, timeout: 60, env: { TABLE_NAME: tableName, BUCKET_NAME: bucketName } },
});

/** API-facing Lambdas: integration settings and who may invoke them. `path`
 *  integrations use the older invocation-path URI form. */
const INTEGRATIONS: Record<string, { timeout: number; path?: boolean; source: string }> = {
  'forecast-api': { timeout: 30000, path: true, source: '/*' },
  'chat-api': { timeout: 30000, path: true, source: '/*' },
  'insights-api': { timeout: 30000, source: '/*/*/insights' },
  'scenarios-api': { timeout: 30000, source: '/*/*' },
  'amplify-oauth': { timeout: 29000, source: '/*/*' },
  'amplify-campaigns': { timeout: 29000, source: '/*/*' },
};

const ROUTES: Record<string, string[]> = {
  'forecast-api': ['GET /forecast'],
  'insights-api': ['GET /insights'],
  'chat-api': ['POST /chat', 'GET /knowledge', 'PUT /knowledge'],
  'scenarios-api': [
    'GET /scenarios', 'POST /scenarios', 'GET /scenarios/{id}/result', 'POST /scenarios/{id}/approve',
    'POST /scenarios/upload-url', 'GET /scenarios/members', 'POST /scenarios/members/role',
    'GET /tickets', 'POST /tickets', 'GET /tickets/{id}', 'POST /tickets/{id}/reply', 'POST /tickets/{id}/status',
  ],
  'amplify-oauth': ['GET /amplify-oauth/status', 'GET /amplify-oauth/{platform}/start',
    'GET /amplify-oauth/{platform}/callback', 'POST /amplify-oauth/{platform}/disconnect'],
  'amplify-campaigns': [
    'GET /amplify-campaigns', 'POST /amplify-campaigns', 'GET /amplify-campaigns/audit',
    'GET /amplify-campaigns/recommendations', 'GET /amplify-campaigns/sku-labels', 'PUT /amplify-campaigns/sku-labels',
    'GET /amplify-campaigns/shopify-products', 'POST /amplify-campaigns/shopify-products/sync',
    'GET /amplify-campaigns/manual-catalog', 'POST /amplify-campaigns/manual-catalog',
    'PATCH /amplify-campaigns/manual-catalog/{id}', 'DELETE /amplify-campaigns/manual-catalog/{id}',
    'GET /amplify-campaigns/{platform}/{id}', 'PATCH /amplify-campaigns/{platform}/{id}',
    'GET /amplify-campaigns/{platform}/{id}/performance',
    'POST /amplify-campaigns/{platform}/{id}/pause', 'POST /amplify-campaigns/{platform}/{id}/resume',
  ],
};

/** Called by the dashboard and implemented in the handler, but missing from
 *  the live API (404). Added only with `-c pendingChanges=true`, so the
 *  default template stays an exact copy of what is live. */
const PENDING_ROUTES: Record<string, string[]> = { 'scenarios-api': ['GET /scenarios/approvals'] };

/** The OAuth redirect arrives from the ad platform without our token. */
const PUBLIC_ROUTES = new Set(['GET /amplify-oauth/{platform}/callback']);

const pascal = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
/** 'GET /x/{id}' -> 'GetXById', kept unique because {id} and id differ. */
const routeId = (key: string) => pascal(key.toLowerCase().replace(/\{(\w+)\}/g, 'by-$1'));

export interface AppStackProps extends StackProps { local: LocalConfig; pendingChanges: boolean }

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const keep = <T extends CfnResource>(logicalId: string, r: T): T => {
      r.overrideLogicalId(logicalId);
      r.applyRemovalPolicy(RemovalPolicy.RETAIN);
      return r;
    };

    const roles: Record<string, CfnRole> = {};
    for (const [logicalId, spec] of Object.entries(ROLES)) {
      roles[logicalId] = keep(logicalId, new CfnRole(this, logicalId, {
        roleName: spec.name,
        assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
        managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        policies: Object.entries(spec.policies).map(([policyName, Statement]) => (
          { policyName, policyDocument: { Version: '2012-10-17', Statement } })),
      }));
    }

    const fns: Record<string, CfnFunction> = {};
    for (const [name, spec] of Object.entries(functions(props.local))) {
      const dir = path.join(process.cwd(), '.build', name);
      if (!fs.existsSync(path.join(dir, 'handler.py'))) throw new Error(`.build/${name} is missing. Run: npm run package`);
      const code = new Asset(this, `${pascal(name)}Code`, { path: dir });
      fns[name] = keep(`${pascal(name)}Fn`, new CfnFunction(this, `${pascal(name)}Fn`, {
        functionName: `aprabot-${name}`,
        runtime: 'python3.12', handler: 'handler.handler', architectures: ['x86_64'], packageType: 'Zip',
        memorySize: spec.memory, timeout: spec.timeout, ephemeralStorage: { size: spec.tmp ?? 512 },
        tracingConfig: { mode: 'PassThrough' },
        role: roles[spec.role].attrArn,
        environment: { variables: spec.env },
        code: { s3Bucket: code.s3BucketName, s3Key: code.s3ObjectKey },
      }));
    }

    keep('AmplifySyncWorkerQueueTrigger', new CfnEventSourceMapping(this, 'AmplifySyncWorkerQueueTrigger', {
      functionName: fns['amplify-sync-worker'].attrArn, eventSourceArn: arn.queue, batchSize: 5,
      maximumBatchingWindowInSeconds: 0, enabled: true, functionResponseTypes: ['ReportBatchItemFailures'],
    }));

    const api = keep('HttpApi', new CfnApi(this, 'HttpApi', {
      name: 'aprabot-forecast', protocolType: 'HTTP',
      corsConfiguration: { allowOrigins: ['*'], allowHeaders: ['content-type', 'authorization'],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] },
    }));
    keep('HttpApiStage', new CfnStage(this, 'HttpApiStage', { apiId: api.ref, stageName: '$default', autoDeploy: true }));
    const authorizer = keep('CognitoAuthorizer', new CfnAuthorizer(this, 'CognitoAuthorizer', {
      apiId: api.ref, name: 'aprabot-cognito-jwt', authorizerType: 'JWT',
      identitySource: ['$request.header.Authorization'],
      jwtConfiguration: { audience: [userPoolClientId], issuer: `https://cognito-idp.${env.region}.amazonaws.com/${userPoolId}` },
    }));

    for (const [name, spec] of Object.entries(INTEGRATIONS)) {
      const fnArn = fns[name].attrArn;
      const integration = keep(`${pascal(name)}Integration`, new CfnIntegration(this, `${pascal(name)}Integration`, {
        apiId: api.ref, integrationType: 'AWS_PROXY', integrationMethod: 'POST', payloadFormatVersion: '2.0',
        timeoutInMillis: spec.timeout, connectionType: 'INTERNET',
        integrationUri: spec.path
          ? Fn.join('', [`arn:aws:apigateway:${env.region}:lambda:path/2015-03-31/functions/`, fnArn, '/invocations'])
          : fnArn,
      }));
      keep(`${pascal(name)}Invoke`, new CfnPermission(this, `${pascal(name)}Invoke`, {
        functionName: fnArn, action: 'lambda:InvokeFunction', principal: 'apigateway.amazonaws.com',
        sourceArn: Fn.join('', [`arn:aws:execute-api:${env.region}:${env.account}:`, api.ref, spec.source]),
      }));
      const keys = [...ROUTES[name], ...(props.pendingChanges ? PENDING_ROUTES[name] ?? [] : [])];
      for (const routeKey of keys) {
        const open = PUBLIC_ROUTES.has(routeKey);
        keep(`Route${routeId(routeKey)}`, new CfnRoute(this, `Route${routeId(routeKey)}`, {
          apiId: api.ref, routeKey, target: Fn.join('/', ['integrations', integration.ref]),
          authorizationType: open ? 'NONE' : 'JWT', ...(open ? {} : { authorizerId: authorizer.ref }),
        }));
      }
    }
  }
}
