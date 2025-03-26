const { CloudFormationClient, DescribeStackResourceCommand } = require("@aws-sdk/client-cloudformation")
const { APIGatewayClient, GetRestApiCommand } = require("@aws-sdk/client-api-gateway")

let memoryCache = {}
let cfnClient
let apiClient

async function getAPIGatewayRestUrl(stackName, region, logicalId) {
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
  const restApiId = resourceData.StackResourceDetail.PhysicalResourceId
  
  // Get API details to construct URL
  if (!apiClient) {
    apiClient = new APIGatewayClient({ region })
  }
  const apiData = await apiClient.send(new GetRestApiCommand({ restApiId }))
  /*
  console.log('apiData', apiData)
  /** */
  // Construct API URL
  const url = `https://${restApiId}.execute-api.${region}.amazonaws.com/${apiData.deploymentStage || 'prod'}`
  memoryCache[cacheKey] = url
  return url
}

if (require.main === module) {
  getAPIGatewayRestUrl('test-service-for-manifest-plugin-dev', 'us-east-1', 'ApiGatewayRestApi').then((url) => {
    console.log(url)
  })
}

module.exports = {
  getAPIGatewayRestUrl
}
