import { App } from 'aws-cdk-lib';
import { env, loadLocalConfig, stage } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { AppStack } from '../lib/app-stack';
import { SiteStack } from '../lib/site-stack';
import { CiStack } from '../lib/ci-stack';

// One stage per synth: `-c stage=prod` (default) or `-c stage=beta`. Each
// stage is its own AWS account, so the stack names are the same in both.
const app = new App();
const st = stage(app.node.tryGetContext('stage'));
const common = { env: env(st), terminationProtection: true };

new DataStack(app, 'AprabotData', { ...common, stage: st,
  description: 'APRABot data and sign-in: forecast bucket, ads table, sync queue, Cognito' });
// The app stack needs the stage's user pool, which exists only after AprabotData is deployed.
if (st.userPoolId) new AppStack(app, 'AprabotApp', { ...common, stage: st,
  description: 'APRABot backend: Lambdas, roles and HTTP API',
  local: loadLocalConfig(),
  pendingChanges: String(app.node.tryGetContext('pendingChanges')) === 'true' });
new SiteStack(app, 'AprabotSite', { ...common, stage: st,
  description: 'APRABot website: S3 bucket and CloudFront' });
// Deployed by hand once per account (the pipeline only deploys the three above).
new CiStack(app, 'AprabotCi', { ...common, stage: st, repo: 'aprabot/homepage',
  description: 'APRABot CI: GitHub Actions OIDC sign-in and deploy role' });
