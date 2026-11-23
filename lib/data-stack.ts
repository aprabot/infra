import { Stack, StackProps, RemovalPolicy, CfnResource } from 'aws-cdk-lib';
import { CfnBucket } from 'aws-cdk-lib/aws-s3';
import { CfnTable } from 'aws-cdk-lib/aws-dynamodb';
import { CfnQueue } from 'aws-cdk-lib/aws-sqs';
import { CfnUserPool, CfnUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { bucketName, queueName, tableName, userPoolName } from './config';

/** Everything that holds data or sign-ins. Deliberately its own stack with no
 *  exports, so no application deploy can touch it; every resource is RETAINed. */
export class DataStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const keep = <T extends CfnResource>(logicalId: string, r: T): T => {
      r.overrideLogicalId(logicalId);
      r.applyRemovalPolicy(RemovalPolicy.RETAIN);
      return r;
    };

    keep('ForecastBucket', new CfnBucket(this, 'ForecastBucket', {
      bucketName,
      bucketEncryption: { serverSideEncryptionConfiguration: [{
        bucketKeyEnabled: false, serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' },
      }] },
      publicAccessBlockConfiguration: {
        blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true,
      },
      ownershipControls: { rules: [{ objectOwnership: 'BucketOwnerEnforced' }] },
      corsConfiguration: { corsRules: [{
        allowedHeaders: ['*'], allowedMethods: ['PUT', 'GET', 'HEAD'],
        allowedOrigins: ['https://aprabot.com', 'https://www.aprabot.com'],
        exposedHeaders: ['ETag'], maxAge: 3000,
      }] },
    })).addPropertyOverride('BucketEncryption.ServerSideEncryptionConfiguration.0.BlockedEncryptionTypes',
      { EncryptionType: ['SSE-C'] });

    keep('AmplifyTable', new CfnTable(this, 'AmplifyTable', {
      tableName,
      billingMode: 'PAY_PER_REQUEST',
      attributeDefinitions: ['gsi1pk', 'gsi1sk', 'pk', 'sk'].map(attributeName => ({ attributeName, attributeType: 'S' })),
      keySchema: [{ attributeName: 'pk', keyType: 'HASH' }, { attributeName: 'sk', keyType: 'RANGE' }],
      globalSecondaryIndexes: [{
        indexName: 'GSI1',
        keySchema: [{ attributeName: 'gsi1pk', keyType: 'HASH' }, { attributeName: 'gsi1sk', keyType: 'RANGE' }],
        projection: { projectionType: 'ALL' },
      }],
      timeToLiveSpecification: { attributeName: 'ttl', enabled: true },
    }));

    keep('AmplifySyncQueue', new CfnQueue(this, 'AmplifySyncQueue', {
      queueName, visibilityTimeout: 120, messageRetentionPeriod: 86400,
      maximumMessageSize: 1048576, sqsManagedSseEnabled: true,
    }));

    const pool = keep('UserPool', new CfnUserPool(this, 'UserPool', {
      userPoolName,
      usernameAttributes: ['email'],
      autoVerifiedAttributes: ['email'],
      mfaConfiguration: 'ON',
      enabledMfas: ['SOFTWARE_TOKEN_MFA'],
      userPoolTier: 'ESSENTIALS',
      policies: { passwordPolicy: {
        minimumLength: 8, requireUppercase: true, requireLowercase: true, requireNumbers: true,
        requireSymbols: false, temporaryPasswordValidityDays: 7,
      }, signInPolicy: { allowedFirstAuthFactors: ['PASSWORD'] } },
      accountRecoverySetting: { recoveryMechanisms: [
        { name: 'verified_email', priority: 1 }, { name: 'verified_phone_number', priority: 2 },
      ] },
      adminCreateUserConfig: { allowAdminCreateUserOnly: false },
      emailConfiguration: { emailSendingAccount: 'COGNITO_DEFAULT' },
      verificationMessageTemplate: { defaultEmailOption: 'CONFIRM_WITH_CODE' },
    }));

    keep('UserPoolWebClient', new CfnUserPoolClient(this, 'UserPoolWebClient', {
      userPoolId: pool.ref,
      clientName: 'aprabot-web',
      explicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_PASSWORD_AUTH'],
      refreshTokenValidity: 30,
      enableTokenRevocation: true,
      authSessionValidity: 3,
    }));
  }
}
