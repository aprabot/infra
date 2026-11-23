# APRABot infrastructure (AWS CDK)

Defines the AWS backend that was previously created by hand. One account, one region (`us-east-1`).

| Stack | Contents |
|---|---|
| `AprabotData` | S3 bucket, DynamoDB table, SQS queue, Cognito user pool and web client |
| `AprabotApp` | 10 Lambdas, 3 IAM roles, HTTP API (routes, integrations, JWT authorizer), API permissions, queue trigger |

Every resource is retained if it leaves a template or a stack is deleted, and both stacks turn on
termination protection. The stacks share no exports, so deploying the app can't touch the data.

The resources **already exist**, so they have to be *imported* (below). A plain `cdk deploy` before
the import fails with "already exists" errors.

This replaces `aprabot/aprabot-infra`, an August 2026 reference snapshot (5 Lambdas, 8 routes) that was
not meant to be deployed.

Not managed here: the website (GitHub Pages), DNS, Secrets Manager values (created at run time by
`amplify-oauth`), objects in S3, CloudWatch log groups (created by Lambda), and Bedrock model access.

## Setup

Needs Node 20+, Python 3.12+, the AWS CLI with credentials, and checkouts of `aprabot/homepage`
(Lambda code) and `aprabot/forecast` (`forecast.py`) next to this repo, or `HOMEPAGE_REPO=<path>`
and `FORECAST_REPO=<path>`.

```bash
npm ci
npm run config    # writes config.local.json from the live Lambda (gitignored)
npm run package   # builds Lambda packages from homepage's last commit, never uncommitted files
npm run verify    # synthesizes, then compares every property with live AWS (read-only, about a minute)
```

`verify` must report `0 difference(s)` before importing.

## First-time adoption (changes AWS; do it once)

```bash
npx cdk bootstrap aws://751835847089/us-east-1   # creates CDKToolkit: an S3 bucket, an ECR repo, IAM roles
npm run map                                      # writes import-<Stack>.json: which live resource is which
npx cdk import AprabotData --resource-mapping import-AprabotData.json
npx cdk import AprabotApp  --resource-mapping import-AprabotApp.json
npx cdk diff                                     # should show no differences
```

Importing records the resources in CloudFormation without modifying them. Run `drift detection` in
the CloudFormation console afterwards as a second check.

**Importing does not deploy code.** CloudFormation compares templates, not running code, so any
Lambda whose live code is older than homepage stays older, and `cdk diff` won't show it. To roll out
that code, change something that is packaged, or update that function once with the AWS CLI.

## Day to day

```bash
npm run package           # or: npm run package -- chat-api
npx cdk diff AprabotApp   # always read this first
npx cdk deploy AprabotApp
```

After adoption, change Lambda settings, routes and IAM here rather than in the console or with
`aws lambda update-function-code`; CloudFormation doesn't see those edits and may overwrite them.

As of 2026-11-22, live code is older than homepage for `amplify-campaigns` and `amplify-sync-worker`,
and `explain-runner` runs slightly older numpy/pytz/tzdata than `packages/model.txt`. The other seven
packages are identical to live.

`forecast.py` is pinned per model Lambda in `scripts/package.py` (`FORECAST_COMMIT`), and Python
dependencies are pinned in `packages/`.

## Pending change

`GET /scenarios/approvals` is implemented in `scenarios-api` and called by the dashboard, but has no
route on the live API, so it returns 404 and approval history never loads. It's off by default to
keep the template identical to live. After adoption:

```bash
npx cdk deploy AprabotApp -c pendingChanges=true
```

Then move it from `PENDING_ROUTES` to `ROUTES` in `lib/app-stack.ts`. Deploying without the flag
before doing that would drop the route from the stack (it is retained in AWS, but no longer managed).

## Known gaps (kept as they are today)

No S3 versioning, no DynamoDB point-in-time recovery or deletion protection, no Cognito deletion
protection, no dead-letter queue, no log retention, API CORS allows any origin, and
`bedrock:InvokeModel` is allowed on `*`. There is deliberately no schedule for
`amplify-sync-dispatcher` (see `lambda/amplify-sync-dispatcher/README.md` in homepage).
