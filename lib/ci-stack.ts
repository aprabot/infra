import { Stack, StackProps } from 'aws-cdk-lib';
import { Effect, OpenIdConnectProvider, PolicyStatement, Role, WebIdentityPrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Stage, siteBucketName } from './config';

/** Lets the GitHub Actions pipeline (in aprabot/homepage) deploy this stage, with
 *  short-lived OIDC credentials (no stored keys). Only jobs that run in the
 *  matching GitHub environment ("beta" or "production") can assume the role.
 *  Deployed by hand once per account; the pipeline never deploys this stack. */
export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { stage: Stage; repo: string }) {
    super(scope, id, props);
    const st = props.stage;
    const environment = st.name === 'prod' ? 'production' : st.name;

    const provider = new OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const role = new Role(this, 'DeployRole', {
      roleName: 'aprabot-github-deploy',
      description: `GitHub Actions (${props.repo}, environment ${environment}) deploying APRABot ${st.name}`,
      assumedBy: new WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${props.repo}:environment:${environment}`,
        },
      }),
    });

    // CDK deploys go through the bootstrap roles (CloudFormation does the work).
    role.addToPolicy(new PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${st.account}:role/cdk-hnb659fds-*-${st.account}-${st.region}`],
    }));
    // Publishing the website and finding what to publish to.
    role.addToPolicy(new PolicyStatement({
      actions: ['s3:ListBucket'], resources: [`arn:aws:s3:::${siteBucketName(st)}`],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['s3:PutObject', 's3:DeleteObject', 's3:GetObject'], resources: [`arn:aws:s3:::${siteBucketName(st)}/*`],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
      resources: [`arn:aws:cloudfront::${st.account}:distribution/*`],
    }));
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['cloudformation:DescribeStacks', 'apigateway:GET'],
      resources: [`arn:aws:cloudformation:${st.region}:${st.account}:stack/Aprabot*/*`, `arn:aws:apigateway:${st.region}::/apis`],
    }));
  }
}
