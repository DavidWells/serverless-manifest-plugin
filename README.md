# Serverless Manifest Plugin

Generate list of api endpoints & stack outputs for consumption in other applications + service discovery.

This will output to `.serverless/manifest.json` file.

## Usage

Add to plugins array in `serverless.yml`

```yml
service: my-example-service

plugins:
 - serverless-manifest-plugin
```

## Example

Outputs `urls`, `functions`, `outputs` etc.

`.serverless/manifest.json`

```json
{
  "dev": {
    "urls": {
      "base": "https://abc-123.execute-api.us-west-1.amazonaws.com/dev",
      "byPath": {
        "track": {
          "url": "https://abc-123.execute-api.us-west-1.amazonaws.com/dev/track",
          "method": [
            "post"
          ]
        },
        "identify": {
          "url": "https://abc-123.execute-api.us-west-1.amazonaws.com/dev/identify",
          "method": [
            "post"
          ]
        }
      },
      "byFunction": {
        "track": {
          "url": "https://abc-123.execute-api.us-west-1.amazonaws.com/dev/track",
          "method": [
            "post"
          ]
        },
        "identify": {
          "url": "https://abc-123.execute-api.us-west-1.amazonaws.com/dev/identify",
          "method": [
            "post"
          ]
        }
      }
    },
    "functions": {
      "track": {
        "name": "my-example-service-dev-track",
        "arn": "arn:aws:lambda:us-west-1:123456:function:my-example-service-dev-track:3"
      },
      "identify": {
        "name": "my-example-service-dev-identify",
        "arn": "arn:aws:lambda:us-west-1:123456:function:my-example-service-dev-identify:3"
      }
    },
    "outputs": [
      {
        "OutputKey": "TrackLambdaFunctionQualifiedArn",
        "OutputValue": "arn:aws:lambda:us-west-1:123456:function:my-example-service-dev-track:3",
        "Description": "Current Lambda function version"
      },
      {
        "OutputKey": "DomainName",
        "OutputValue": "1234abcd.cloudfront.net"
      },
      {
        "OutputKey": "HostedZoneId",
        "OutputValue": "abcdef"
      },
      {
        "OutputKey": "IdentifyLambdaFunctionQualifiedArn",
        "OutputValue": "arn:aws:lambda:us-west-1:123456:function:my-example-service-dev-identify:3",
        "Description": "Current Lambda function version"
      },
      {
        "OutputKey": "ServiceEndpoint",
        "OutputValue": "https://abc-123.execute-api.us-west-1.amazonaws.com/dev",
        "Description": "URL of the service endpoint"
      },
      {
        "OutputKey": "ServerlessDeploymentBucketName",
        "OutputValue": "my-example-service-serverlessdeploymentbuck-abc123"
      }
    ]
  }
}
```