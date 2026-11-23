#!/usr/bin/env python3
"""Read-only helpers that compare the CDK templates with live AWS.

  live.py config   write config.local.json from the live amplify-oauth Lambda
  live.py map      write import-<Stack>.json for `cdk import --resource-mapping`
  live.py verify   check every templated property equals the live one
                   (-v also lists live settings the template doesn't manage)

Uses the AWS CLI; never changes anything in AWS and never prints Lambda
environment values.
"""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

INFRA = Path(__file__).resolve().parent.parent
STACKS = ['AprabotData', 'AprabotApp']
API_ID = 'ktksptlz75'
POOL_ID, CLIENT_ID = 'us-east-1_fb34nECGY', '5g9h8366bt5j8el588eh3lh5n4'
REGION, ACCOUNT = 'us-east-1', '751835847089'
# Write-only in CloudFormation, so AWS never reports them back.
WRITE_ONLY = {'AWS::Lambda::Function': {'Code'}, 'AWS::ApiGatewayV2::Route': {'AuthorizerId'},
              'AWS::Cognito::UserPool': {'EnabledMfas'}}


# Cloud Control throttles quickly; let the CLI back off and retry.
os.environ.update(AWS_RETRY_MODE='adaptive', AWS_MAX_ATTEMPTS='12')


def aws(*args):
    p = subprocess.run(['aws', *args, '--region', REGION, '--output', 'json', '--no-cli-pager'], capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(p.stderr.strip())
    return json.loads(p.stdout or 'null')


def get(type_name, identifier):
    d = aws('cloudcontrol', 'get-resource', '--type-name', type_name, '--identifier', identifier)
    return json.loads(d['ResourceDescription']['Properties'])


def list_models(type_name, model):
    out = aws('cloudcontrol', 'list-resources', '--type-name', type_name, '--resource-model', json.dumps(model))
    return [json.loads(r['Properties']) for r in out['ResourceDescriptions']]


class Live:
    """Finds the live resource behind each templated one."""
    def __init__(self):
        self.resources = {}
        for s in STACKS:
            t = json.loads((INFRA / f'cdk.out/{s}.template.json').read_text())
            for lid, r in t['Resources'].items():
                self.resources[lid] = (s, r['Type'], r['Properties'])
        self.routes = {r['RouteKey']: r['RouteId'] for r in self.items('get-routes')}
        self.integrations = {r['IntegrationUri']: r['IntegrationId'] for r in self.items('get-integrations')}
        self.authorizers = {r['Name']: r['AuthorizerId'] for r in self.items('get-authorizers')}
        self.cache = {}

    @staticmethod
    def items(op):
        return aws('apigatewayv2', op, '--api-id', API_ID)['Items']

    def value(self, v):
        """Resolve the intrinsic functions the templates use."""
        if isinstance(v, list):
            return [self.value(x) for x in v]
        if not isinstance(v, dict):
            return v
        if len(v) == 1:
            (k, a), = v.items()
            if k == 'Ref':
                return self.ref(a) if a in self.resources else {'AWS::Region': REGION, 'AWS::AccountId': ACCOUNT, 'AWS::Partition': 'aws'}.get(a, v)
            if k == 'Fn::GetAtt' and a[1] == 'Arn':
                return self.arn(a[0])
            if k == 'Fn::Join':
                parts = self.value(a[1])
                return a[0].join(parts) if all(isinstance(p, str) for p in parts) else v
        return {k: self.value(x) for k, x in v.items()}

    def arn(self, lid):
        _, t, p = self.resources[lid]
        return {'AWS::IAM::Role': lambda: f'arn:aws:iam::{ACCOUNT}:role/{p["RoleName"]}',
                'AWS::Lambda::Function': lambda: f'arn:aws:lambda:{REGION}:{ACCOUNT}:function:{p["FunctionName"]}'}[t]()

    def ref(self, lid):
        ident = self.identify(lid)
        return list(ident.values())[-1] if self.resources[lid][1] != 'AWS::ApiGatewayV2::Authorizer' else ident['AuthorizerId']

    def identify(self, lid):
        if lid in self.cache:
            return self.cache[lid]
        _, t, p = self.resources[lid]
        short = t.split('::', 1)[1]
        if short == 'S3::Bucket': i = {'BucketName': p['BucketName']}
        elif short == 'DynamoDB::Table': i = {'TableName': p['TableName']}
        elif short == 'SQS::Queue': i = {'QueueUrl': f'https://sqs.{REGION}.amazonaws.com/{ACCOUNT}/{p["QueueName"]}'}
        elif short == 'Cognito::UserPool': i = {'UserPoolId': POOL_ID}
        elif short == 'Cognito::UserPoolClient': i = {'UserPoolId': POOL_ID, 'ClientId': CLIENT_ID}
        elif short == 'IAM::Role': i = {'RoleName': p['RoleName']}
        elif short == 'Lambda::Function': i = {'FunctionName': p['FunctionName']}
        elif short == 'ApiGatewayV2::Api': i = {'ApiId': API_ID}
        elif short == 'ApiGatewayV2::Stage': i = {'ApiId': API_ID, 'StageName': p['StageName']}
        elif short == 'ApiGatewayV2::Authorizer': i = {'ApiId': API_ID, 'AuthorizerId': self.authorizers[p['Name']]}
        elif short == 'ApiGatewayV2::Integration': i = {'ApiId': API_ID, 'IntegrationId': self.integrations[self.value(p['IntegrationUri'])]}
        elif short == 'ApiGatewayV2::Route':
            if p['RouteKey'] not in self.routes: raise KeyError(f'route {p["RouteKey"]} is not live')
            i = {'ApiId': API_ID, 'RouteId': self.routes[p['RouteKey']]}
        elif short == 'Lambda::Permission':
            fn, src = self.value(p['FunctionName']), self.value(p['SourceArn'])
            m = next(m for m in list_models(t, {'FunctionName': fn}) if m.get('SourceArn') == src)
            i = {'FunctionName': m['FunctionName'], 'Id': m['Id']}
        elif short == 'Lambda::EventSourceMapping':
            m, = aws('lambda', 'list-event-source-mappings', '--function-name', self.value(p['FunctionName']))['EventSourceMappings']
            i = {'Id': m['UUID']}
        else: raise KeyError(f'no import rule for {t}')
        self.cache[lid] = i
        return i


def same(want, have):
    """Everything in `want` is in `have` (lists of scalars ignore order)."""
    if isinstance(want, dict):
        return isinstance(have, dict) and all(k in have and same(v, have[k]) for k, v in want.items())
    if isinstance(want, list):
        if not isinstance(have, list) or len(want) != len(have): return False
        left = list(have)
        for w in want:
            hit = next((h for h in left if same(w, h)), None)
            if hit is None and not any(h is None for h in left): return False
            left.remove(hit)
        return True
    return str(want).lower() == str(have).lower() if isinstance(want, bool) or isinstance(have, bool) else str(want) == str(have)


def as_doc(v):
    return json.loads(v) if isinstance(v, str) and v.startswith('{') else v


# CloudFormation identifiers in the order Cloud Control expects them.
ORDER = {'AWS::ApiGatewayV2::Authorizer': ('AuthorizerId', 'ApiId')}


def verify(verbose):
    live, bad, n, claimed = Live(), 0, 0, {}

    def fetch(lid):
        t = live.resources[lid][1]
        try:
            ident = live.identify(lid)
            keys = ORDER.get(t, tuple(ident))
            return ident, keys, get(t, '|'.join(ident[k] for k in keys))
        except (KeyError, StopIteration, ValueError) as e:
            return e
        except RuntimeError as e:
            if 'NotFound' in str(e): return e
            raise

    # Few enough at a time to stay under Cloud Control's rate limit.
    with ThreadPoolExecutor(3) as pool:
        found = dict(zip(live.resources, pool.map(fetch, live.resources)))
    for lid, (stack, t, props) in live.resources.items():
        n += 1
        if isinstance(found[lid], Exception):
            bad += 1; print(f'NOT LIVE  {lid} ({t}): {found[lid]}'); continue
        ident, keys, have = found[lid]
        claimed.setdefault(t, []).append('|'.join(ident[k] for k in keys))
        for k, want in props.items():
            if k in WRITE_ONLY.get(t, ()): continue
            want, got = live.value(want), as_doc(have.get(k))
            if t == 'AWS::IAM::Role' and k == 'Policies':
                got = [{**p, 'PolicyDocument': as_doc(p['PolicyDocument'])} for p in got or []]
            if not same(want, got):
                bad += 1
                hidden = k == 'Environment'
                print(f'DIFFERS   {lid}.{k}\n   cdk:  {"<hidden> keys=" + str(sorted(want["Variables"])) if hidden else json.dumps(want)[:700]}'
                      f'\n   live: {"<hidden> keys=" + str(sorted((got or {}).get("Variables", {}))) if hidden else json.dumps(got)[:700]}')
            # A live Lambda variable or role policy the template lacks would be removed on deploy.
            if hidden_extra := (set((got or {}).get('Variables', {})) - set(want.get('Variables', {})) if k == 'Environment' else set()):
                bad += 1; print(f'EXTRA     {lid} has live env vars not in CDK: {sorted(hidden_extra)}')
        if verbose:
            extra = sorted(set(have) - set(props))
            print(f'          {lid}: unmanaged live properties {extra}')
    # Live resources of the managed kinds that CDK doesn't know about.
    auths = {r['RouteKey']: r.get('AuthorizerId') for r in live.items('get-routes')}
    wanted = {p['RouteKey']: live.value(p['AuthorizerId']) if 'AuthorizerId' in p else None
              for _, t, p in live.resources.values() if t == 'AWS::ApiGatewayV2::Route'}
    for key, a in auths.items():
        if key not in wanted: bad += 1; print(f'UNMANAGED route {key}')
        elif wanted[key] != a: bad += 1; print(f'DIFFERS   authorizer on {key}')
    fns = {f['FunctionName'] for f in aws('lambda', 'list-functions')['Functions'] if f['FunctionName'].startswith('aprabot-')}
    for f in sorted(fns - set(claimed.get('AWS::Lambda::Function', []))): bad += 1; print(f'UNMANAGED Lambda {f}')
    perms = sum(len(list_models('AWS::Lambda::Permission', {'FunctionName': f})) for f in fns
                if subprocess.run(['aws', 'lambda', 'get-policy', '--function-name', f, '--region', REGION], capture_output=True).returncode == 0)
    if perms != len(claimed.get('AWS::Lambda::Permission', [])): bad += 1; print(f'UNMANAGED Lambda permissions: live {perms}, CDK {len(claimed.get("AWS::Lambda::Permission", []))}')
    print(f'{n} resources checked, {bad} difference(s).')
    return 1 if bad else 0


def write_map():
    live, per = Live(), {s: {} for s in STACKS}
    for lid, (stack, _, _) in live.resources.items():
        per[stack][lid] = live.identify(lid)
    for s, m in per.items():
        (INFRA / f'import-{s}.json').write_text(json.dumps(m, indent=2) + '\n')
        print(f'import-{s}.json  {len(m)} resources')


def write_config():
    v = aws('lambda', 'get-function-configuration', '--function-name', 'aprabot-amplify-oauth')['Environment']['Variables']
    f = INFRA / 'config.local.json'
    f.touch(mode=0o600)
    f.write_text(json.dumps({'shopifyApiKey': v['SHOPIFY_API_KEY'], 'googleOAuthClientId': v['GOOGLE_OAUTH_CLIENT_ID']}, indent=2) + '\n')
    print('Wrote config.local.json (gitignored).')


cmd = sys.argv[1] if len(sys.argv) > 1 else ''
if cmd == 'config': write_config()
elif cmd == 'map': write_map()
elif cmd == 'verify': sys.exit(verify('-v' in sys.argv))
else: sys.exit(__doc__)
