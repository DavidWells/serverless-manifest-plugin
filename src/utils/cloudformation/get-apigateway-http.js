const safe = require('safe-await')
const { getAPIGatewayHttpDetails } = require("../apigateway-http/get-api-details")
const { describeStackResource } = require("./describe-stack-resource")

let memoryCache = {}

async function getAPIGatewayHttpDetailsByLogicalId(stackName, logicalId, region = 'us-east-1') {
  const cacheKey = `${stackName}-${logicalId}-${region}`
  
  if (memoryCache[cacheKey]) {
    return memoryCache[cacheKey]
  }
  
  /* Get resource by logicalId */
  const [ stackResourceError, stackResourceResult ] = await safe(describeStackResource(stackName, logicalId, region))
  if (stackResourceError) {
    console.log(`${logicalId} not found in ${stackName}`, stackResourceError)
  }
  const stackResourceDetail = stackResourceResult || {}
  /*
  console.log('stackResourceDetail', stackResourceDetail)
  /** */
  
  /* Get API details */
  const apiId = stackResourceDetail.PhysicalResourceId
  if (!apiId) {
    console.log(`${logicalId} not found in ${stackName}`)
    return {}
  }
  
  const [ apiDataError, apiDataResult ] = await safe(getAPIGatewayHttpDetails(apiId, region))
  if (apiDataError) {
    console.log(`${apiId} not found in ${stackName}`)
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

async function getAPIGatewayHttpUrl(stackName, logicalId, region) {
  const apiData = await getAPIGatewayHttpDetailsByLogicalId(stackName, logicalId, region)
  return apiData.ApiEndpoint
}

if (require.main === module) {
  const stackName = process.argv[2] || 'test-service-for-manifest-plugin-dev'
  const logicalId = process.argv[3] || 'HttpApi'
  const region =    process.argv[4] || 'us-east-1'
  getAPIGatewayHttpDetailsByLogicalId(stackName, logicalId, region).then((url) => {
    console.log(url)
  })
}

module.exports = {
  getAPIGatewayHttpDetailsByLogicalId,
  getAPIGatewayHttpUrl
}
