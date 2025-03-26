const { CloudFormationClient, DescribeStackResourceCommand } = require("@aws-sdk/client-cloudformation")
const { ApiGatewayV2Client, GetApiCommand } = require("@aws-sdk/client-apigatewayv2")

let memoryCache = {}
let cfnClient
let apiClient

async function getAPIGatewayHttpUrl(stackName, region, logicalId) {
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
  const apiId = resourceData.StackResourceDetail.PhysicalResourceId
  
  // Get API details
  if (!apiClient) {
    apiClient = new ApiGatewayV2Client({ region })
  }
  const apiData = await apiClient.send(new GetApiCommand({ ApiId: apiId }))
  /*
  console.log('apiData', apiData)
  /** */

  memoryCache[cacheKey] = apiData.ApiEndpoint
  return apiData.ApiEndpoint
}

if (require.main === module) {
  getAPIGatewayHttpUrl('test-service-for-manifest-plugin-dev', 'us-east-1', 'HttpApi').then((url) => {
    console.log(url)
  })
}

module.exports = {
  getAPIGatewayHttpUrl
}
