const { LambdaClient, GetFunctionUrlConfigCommand } = require("@aws-sdk/client-lambda")

let memoryCache = {}

async function getFunctionUrlConfig(functionName, region) {
  const cacheKey = `${functionName}-${region}`
  if (memoryCache[cacheKey]) {
    return memoryCache[cacheKey]
  }

  const client = new LambdaClient({ region: region })
  
  try {
    const command = new GetFunctionUrlConfigCommand({
      FunctionName: functionName
    })
    
    const apiData = await client.send(command)
    delete apiData['$metadata']
    /*
    console.log('apiData', apiData)
    /** */
    const response = Object.assign({ url: apiData.FunctionUrl }, apiData)
    memoryCache[cacheKey] = response
    return response
  } catch (error) {
    if (error.name === "ResourceNotFoundException" || error.$metadata?.httpStatusCode === 404) {
      return null
    }
    console.error("Error fetching function URL config:", error)
    throw error
  }
}

if (require.main === module) {
  const functionName = process.argv[2] || 'test-service-for-manifest-plugin-dev-fnurl'
  const region = process.argv[3] || 'us-east-1'
  getFunctionUrlConfig(functionName, region).then((data) => {
    console.log(data)
  })
}

module.exports = {
  getFunctionUrlConfig
}
