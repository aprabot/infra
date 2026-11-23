import { App } from 'aws-cdk-lib';
import { env, loadLocalConfig } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { AppStack } from '../lib/app-stack';

const app = new App();
new DataStack(app, 'AprabotData', { env, terminationProtection: true,
  description: 'APRABot data and sign-in: forecast bucket, ads table, sync queue, Cognito' });
new AppStack(app, 'AprabotApp', { env, terminationProtection: true,
  description: 'APRABot backend: Lambdas, roles and HTTP API',
  local: loadLocalConfig(),
  pendingChanges: String(app.node.tryGetContext('pendingChanges')) === 'true' });
