const { describeStackResource } = require("./describe-stack-resource")
const { getAPIGatewayRestDetails } = require("../apigateway-rest/get-api-details")

let memoryCache = {}

async function getAPIGatewayRestDetailsByLogicalId(stackName, logicalId, region) {
  const cacheKey = `${stackName}-${logicalId}-${region}`
  if (memoryCache[cacheKey]) {
    return memoryCache[cacheKey]
  }
  /* Get resource by logicalId */
  const stackResourceDetail = await describeStackResource(stackName, logicalId, region)
  /*
  console.log('stackResourceDetail', stackResourceDetail)
  /** */
  
  /* Get API details */
  const restApiId = stackResourceDetail.PhysicalResourceId
  const apiData = await getAPIGatewayRestDetails(restApiId, region)
  /*
  console.log('apiData', apiData)
  /** */

  memoryCache[cacheKey] = apiData
  return apiData
}

async function getAPIGatewayRestUrl(stackName, logicalId, region) {
  const apiData = await getAPIGatewayRestDetailsByLogicalId(stackName, logicalId, region)
  return apiData.url
}

if (require.main === module) {
  getAPIGatewayRestDetailsByLogicalId('test-service-for-manifest-plugin-dev', 'ApiGatewayRestApi', 'us-east-1').then((restApiData) => {
    console.log('restApiData', restApiData)
  })
}

module.exports = {
  getAPIGatewayRestDetailsByLogicalId,
  getAPIGatewayRestUrl
}
