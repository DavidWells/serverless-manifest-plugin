const { CloudFormationClient, DescribeStackResourceCommand } = require("@aws-sdk/client-cloudformation")

let memoryCache = {}
let cfnClient

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

  memoryCache[cacheKey] = resourceData.StackResourceDetail
  return resourceData.StackResourceDetail
}

if (require.main === module) {
  describeStackResource('company-david-api-rest-prod', 'ApiGatewayResourceV1', 'us-east-1').then((resourceData) => {
    console.log(resourceData)
  })
}

module.exports = {
  describeStackResource
}
