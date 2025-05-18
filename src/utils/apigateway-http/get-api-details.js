const { ApiGatewayV2Client, GetApiCommand } = require("@aws-sdk/client-apigatewayv2")

let memoryCache = {}

let apiClient

async function getAPIGatewayHttpDetails(apiId, region = 'us-east-1') {
  const cacheKey = `${apiId}-${region}`

  if (memoryCache[cacheKey]) {
    return memoryCache[cacheKey]
  }

  // Get API details
  if (!apiClient) {
    apiClient = new ApiGatewayV2Client({ region })
  }
  const apiData = await apiClient.send(new GetApiCommand({ ApiId: apiId }))
  delete apiData['$metadata']
  //*
  console.log('apiData', apiData)
  /** */
  const response = Object.assign({ url: apiData.ApiEndpoint }, apiData)

  memoryCache[cacheKey] = response
  return response
}

if (require.main === module) {
  getAPIGatewayHttpDetails('pvkcfpz3ml', 'us-west-1').then((url) => {
    console.log(url)
  })
}

module.exports = {
  getAPIGatewayHttpDetails
}
