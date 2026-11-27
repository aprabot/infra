import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods, CachePolicy, Distribution, Function as CfFunction, FunctionCode, FunctionEventType,
  FunctionRuntime, HeadersFrameOption, HeadersReferrerPolicy, HttpVersion, PriceClass, ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';
import { Stage, siteBucketName } from './config';

/** The website: a private S3 bucket behind CloudFront. The pipeline uploads
 *  the files (`scripts/publish-site.sh`); this stack only holds the hosting. */
export class SiteStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { stage: Stage }) {
    super(scope, id, props);
    const st = props.stage;
    const canonical = st.domains[0];

    const bucket = new Bucket(this, 'SiteBucket', {
      bucketName: siteBucketName(st),
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Serve URLs the way GitHub Pages did: "/" and "/dashboard/" get index.html,
    // "/about" gets about.html, "/dashboard" gets dashboard/index.html. The
    // stage's extra hostnames (www) redirect to the first one.
    const urls = new CfFunction(this, 'UrlFunction', {
      functionName: `aprabot-site-urls-${st.name}`,
      runtime: FunctionRuntime.JS_2_0,
      comment: 'Pages-style URLs and canonical host',
      code: FunctionCode.fromInline(`
var CANONICAL = ${JSON.stringify(canonical)};
var REDIRECT = ${JSON.stringify(Object.fromEntries(st.domains.slice(1).map(d => [d, 1])))};
var DIRS = { dashboard: 1, amplify: 1, 'redesign-mockup': 1 };
function handler(event) {
  var r = event.request, uri = r.uri, host = r.headers.host && r.headers.host.value;
  if (host && REDIRECT[host]) {
    var qs = Object.keys(r.querystring).map(function (k) {
      var q = r.querystring[k]; return q.multiValue ? q.multiValue.map(function (m) { return k + '=' + m.value; }).join('&') : k + '=' + q.value;
    }).join('&');
    return { statusCode: 301, statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://' + CANONICAL + uri + (qs ? '?' + qs : '') } } };
  }
  var last = uri.split('/').pop();
  if (uri.endsWith('/')) r.uri = uri + 'index.html';
  else if (last.indexOf('.') === -1) {
    var parts = uri.split('/').filter(Boolean);
    r.uri = parts.length === 1 && !DIRS[parts[0]] ? uri + '.html' : uri + '/index.html';
  }
  return r;
}`),
    });

    const headers = new ResponseHeadersPolicy(this, 'Headers', {
      responseHeadersPolicyName: `aprabot-site-headers-${st.name}`,
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.SAMEORIGIN, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
      customHeadersBehavior: st.noindex
        ? { customHeaders: [{ header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true }] } : undefined,
    });

    const distribution = new Distribution(this, 'Distribution', {
      comment: `APRABot website (${st.name})`,
      defaultRootObject: 'index.html',
      ...(st.certificateArn ? {
        domainNames: st.domains,
        certificate: Certificate.fromCertificateArn(this, 'Certificate', st.certificateArn),
      } : {}),
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_ALL,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: headers,
        functionAssociations: [{ function: urls, eventType: FunctionEventType.VIEWER_REQUEST }],
      },
      // A missing file comes back from S3 as 403 (the bucket is private).
      errorResponses: [403, 404].map(httpStatus => ({ httpStatus, responseHttpStatus: 404,
        responsePagePath: '/index.html', ttl: Duration.seconds(10) })),
    });

    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
  }
}
