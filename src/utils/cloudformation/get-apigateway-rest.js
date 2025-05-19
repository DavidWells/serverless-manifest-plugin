const safe = require('safe-await')
const { describeStackResource } = require("./describe-stack-resource")
const { getAPIGatewayRestDetails } = require("../apigateway-rest/get-api-details")

let memoryCache = {}

async function getAPIGatewayRestDetailsByLogicalId(stackName, logicalId, region) {
  const cacheKey = `${stackName}-${logicalId}-${region}`
  if (memoryCache[cacheKey]) {
    return memoryCache[cacheKey]
  }
  /* Get resource by logicalId */
  const [stackResourceResult, stackResourceError] = await safe(describeStackResource(stackName, logicalId, region))
  if (stackResourceError) {
    console.log(`${logicalId} not found in ${stackName}`)
  }
  const stackResourceDetail = stackResourceResult || {}
  /*
  console.log('stackResourceDetail', stackResourceDetail)
  /** */
  
  /* Get API details */
  const restApiId = stackResourceDetail.PhysicalResourceId

  if (!restApiId) {
    console.log(`${logicalId} not found in ${stackName}`)
    return {}
  }

  console.log('restApiId', restApiId)
  const [apiDataResult, apiDataError] = await safe(getAPIGatewayRestDetails(restApiId, region))
  if (apiDataError) {
    console.log(`${restApiId} not found in ${stackName}`)
  }
  const apiData = apiDataResult || {}
  /*
  console.log('apiData', apiData)
  /** */
  if (apiDataResult) {
    memoryCache[cacheKey] = apiData
  }
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
