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

### Generating a manifest file

The plugin will automatically create the manifest when you run `sls deploy`


You can also manually generate the manifest at anytime with

```
sls manifest
```

### Programatic usage

Using the `json` flag will pipe the `stdout` of the manifest. You can use this with a tool like [`jq`](https://stedolan.github.io/jq/) to do something programatic with the data.

```
sls manifest --json
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
      },
      "byMethod": {
        "post": [
          "https://abc-123.execute-api.us-west-1.amazonaws.com/dev/track",
          "https://abc-123.execute-api.us-west-1.amazonaws.com/dev/identify"
        ]
      }
    },
    "functions": {
      "track": {
        "name": "my-example-service-dev-track",
        "arn": "arn:aws:lambda:us-west-1:123456:function:my-example-service-dev-track:3",
        "runtime": "nodejs8.10",
        "triggers": [
          [
            "http"
          ]
        ],
        "dependancies": {
          "direct": [
            "analytics-node"
          ],
          "nested": [
            "uuid",
            "remove-trailing-slash"
          ]
        }
      },
      "identify": {
        "name": "my-example-service-dev-identify",
        "arn": "arn:aws:lambda:us-west-1:123456:function:my-example-service-dev-identify:3",
        "runtime": "nodejs8.10",
        "triggers": [
          [
            "http"
          ]
        ],
        "dependancies": {
          "direct": [
            "analytics-node"
          ],
          "nested": [
            "uuid",
            "remove-trailing-slash"
          ]
        }
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
