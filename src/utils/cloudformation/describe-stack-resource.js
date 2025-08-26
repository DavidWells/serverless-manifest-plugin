const { CloudFormationClient, DescribeStackResourceCommand } = require("@aws-sdk/client-cloudformation")

let memoryCache = {}
let cfnClient

/**
 * Constructs ARN from CloudFormation resource details
 * @param {Object} resource - The StackResourceDetail object
 * @param {string} region - AWS region
 * @returns {string} The constructed ARN
 */
function constructArn(resource, region) {
  const { ResourceType, PhysicalResourceId } = resource
  
  // Extract account ID from stack ARN
  const accountId = resource.StackId.split(':')[4]
  
  switch (ResourceType) {
    case 'AWS::ApiGatewayV2::Api':
      return `arn:aws:apigateway:${region}::/apis/${PhysicalResourceId}`
    case 'AWS::ApiGateway::RestApi':
      return `arn:aws:apigateway:${region}::/restapis/${PhysicalResourceId}`
    case 'AWS::Lambda::Function':
      return `arn:aws:lambda:${region}:${accountId}:function:${PhysicalResourceId}`
    case 'AWS::DynamoDB::Table':
      return `arn:aws:dynamodb:${region}:${accountId}:table/${PhysicalResourceId}`
    case 'AWS::S3::Bucket':
      return `arn:aws:s3:::${PhysicalResourceId}`
    case 'AWS::IAM::Role':
      return `arn:aws:iam::${accountId}:role/${PhysicalResourceId}`
    default:
      // For resources that already have ARN as PhysicalResourceId
      if (PhysicalResourceId.startsWith('arn:')) {
        return PhysicalResourceId
      }
      // Fallback - return the physical resource ID
      return PhysicalResourceId
  }
}

async function describeStackResource(stackName, logicalId, region = 'us-east-1') {
  const cacheKey = `${stackName}-${logicalId}-${region}`
  
  if (memoryCache[cacheKey]) {
    return memoryCache[cacheKey]
  }

  // Initialize CloudFormation client
  if (!cfnClient) {
    cfnClient = new CloudFormationClient({ region })
  }
  
  // Get physical resource ID from logical ID
  const resourceParams = {
    StackName: stackName,
    LogicalResourceId: logicalId
  }
  
  const resourceData = await cfnClient.send(new DescribeStackResourceCommand(resourceParams))

  console.log('resourceData', resourceData)
  const resourceDetail = resourceData.StackResourceDetail

    // Construct ARN based on resource type
  const arn = constructArn(resourceDetail, region)
  console.log('MY_ARN', arn)

   const result = {
    ...resourceDetail,
    arn
  }

  memoryCache[cacheKey] = result
  return result
}

if (require.main === module) {
  describeStackResource('company-david-api-rest-prod', 'ApiGatewayResourceV1', 'us-east-1').then((resourceData) => {
    console.log(resourceData)
  })
}

module.exports = {
  describeStackResource
}
