# APRABot infrastructure (AWS CDK)

Defines APRABot's AWS backend and website hosting, in two stages that are separate AWS accounts in
one organization (`o-bgz7rldcao`), both in `us-east-1`:

| Stage | Account | Site | Notes |
|---|---|---|---|
| `prod` | 751835847089 (management) | aprabot.com | Originally built by hand; imported into CloudFormation on 2026-11-27 |
| `beta` | 760541124025 (`aprabot-beta`) | beta.aprabot.com | Own Cognito pool, API, data; started empty |

Per-stage values (account, domains, certificate, Cognito IDs) are in `stages.json`. Pick a stage with
`-c stage=prod` (the default) or `-c stage=beta`. Stack names are the same in both accounts.

| Stack | Contents |
|---|---|
| `AprabotData` | S3 bucket, DynamoDB table, SQS queue, Cognito user pool and web client |
| `AprabotApp` | 10 Lambdas, 3 IAM roles, HTTP API (routes, integrations, JWT authorizer), API permissions, queue trigger |
| `AprabotSite` | Website hosting: private S3 bucket, CloudFront (Pages-style URLs, security headers; noindex on beta) |
| `AprabotCi` | GitHub OIDC provider and the `aprabot-github-deploy` role the pipeline uses. Deployed by hand only |

Data and app resources are retained if they leave a template or a stack is deleted, and the stacks
turn on termination protection. The stacks share no exports, so deploying the app can't touch the data.
`AprabotApp` needs the stage's Cognito IDs in `stages.json`, so a new stage deploys `AprabotData` first.

## Pipeline

`.github/workflows/deploy.yml` in **aprabot/homepage** runs on every push to its `main` (or by hand,
e.g. after a change here: Actions → Deploy → Run workflow):

1. **beta**: package the Lambdas from that homepage commit, `cdk deploy` the three stacks with
   `-c stage=beta`, publish the website (`scripts/publish-site.sh`, which swaps in beta's API and
   Cognito IDs and adds a badge and noindex), then `scripts/smoke.sh`.
2. **prod**: waits for approval on the `production` environment, then the same with `-c stage=prod`.

The jobs sign in with OIDC (no stored keys); each account's role only trusts its own GitHub environment.
Not managed here: DNS (GoDaddy), Secrets Manager values (created at run time by `amplify-oauth`),
objects in S3, CloudWatch log groups, and Bedrock model access.

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

## First-time adoption of prod (done 2026-11-27; kept for reference)

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

Normally the pipeline deploys. To look at or deploy one stage by hand (beta needs credentials for
its account, e.g. the organization's `OrganizationAccountAccessRole`):

```bash
npm run package                          # or: npm run package -- chat-api
npx cdk diff -c stage=beta               # always read this first
npx cdk deploy AprabotApp -c stage=beta
scripts/publish-site.sh beta             # website only
scripts/smoke.sh beta
```

Change Lambda settings, routes and IAM here rather than in the console or with
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
