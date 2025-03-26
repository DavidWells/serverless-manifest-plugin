const { LambdaClient, GetFunctionUrlConfigCommand } = require("@aws-sdk/client-lambda")

async function getFunctionUrlConfig(functionName, region) {
  const client = new LambdaClient({ region: region })
  
  try {
    const command = new GetFunctionUrlConfigCommand({
      FunctionName: functionName
    })
    
    const response = await client.send(command)
    /*
    console.log('response', response)
    /** */
    return {
      arn: response.FunctionArn,
      url: response.FunctionUrl,
      authType: response.AuthType,
      cors: response.Cors,
      creationTime: response.CreationTime,
      lastModifiedTime: response.LastModifiedTime,
      invokeMode: response.InvokeMode
    }
  } catch (error) {
    if (error.name === "ResourceNotFoundException" || error.$metadata?.httpStatusCode === 404) {
      return null
    }
    console.error("Error fetching function URL config:", error)
    throw error
  }
}

function removeDuplicates(arr) {
  const grouped = {}
  
  // Group by fnName
  for (const item of arr) {
    if (!grouped[item.fnName]) {
      grouped[item.fnName] = []
    }
    grouped[item.fnName].push(item)
  }
  
  // Process each group
  const result = []
  for (const fnName in grouped) {
    const items = grouped[fnName]
    
    // Find items with url
    const withUrl = items.filter(item => item.url)
    
    // Choose base object
    const baseObj = withUrl.length > 0 ? withUrl[0] : items[0]
    
    // Merge any unique keys from other objects
    const mergedObj = items.reduce((merged, item) => {
      // Skip if it's the base object
      if (item === baseObj) return merged
      
      // Add any keys that don't exist on merged object
      Object.keys(item).forEach(key => {
        if (merged[key] === undefined) {
          merged[key] = item[key]
        }
      })
      
      return merged
    }, {...baseObj})

    delete mergedObj.via
    
    result.push(mergedObj)
  }
  
  return result
}

/*
getFunctionUrlConfig('todo-api-three-dev-getAllArt', 'us-east-1').then((url) => {
  console.log(url)
})
// process.exit(1)
/** */

module.exports = { getFunctionUrlConfig, removeDuplicates }