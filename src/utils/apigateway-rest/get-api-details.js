const { APIGatewayClient, GetRestApiCommand } = require("@aws-sdk/client-api-gateway")

let memoryCache = {}
let apiClient

async function getAPIGatewayRestDetails(restApiId, region) {
  const cacheKey = `${restApiId}-${region}`
  
  if (memoryCache[cacheKey]) {
    return memoryCache[cacheKey]
  }
  
  // Get API details to construct URL
  if (!apiClient) {
    apiClient = new APIGatewayClient({ region })
  }
  const apiData = await apiClient.send(new GetRestApiCommand({ restApiId }))
  delete apiData['$metadata']
  /*
  console.log('apiData', apiData)
  /** */
  // Construct API URL
  const url = `https://${restApiId}.execute-api.${region}.amazonaws.com/${apiData.deploymentStage || 'prod'}`
  const response = Object.assign({ url }, apiData)
  
  memoryCache[cacheKey] = response
  return response
}

if (require.main === module) {
  getAPIGatewayRestDetails('wf7phyuoj3', 'us-east-1').then((apiData) => {
    console.log(apiData)
  })
}

module.exports = {
  getAPIGatewayRestDetails
}
