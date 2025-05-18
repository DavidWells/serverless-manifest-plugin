const { CloudFormationClient, DescribeStackResourcesCommand } = require("@aws-sdk/client-cloudformation")

let memoryCache = {}
let client

async function describeStackResources(stackName, region) {
  const cacheKey = `${stackName}-${region}`
  if (memoryCache[cacheKey]) {
    return memoryCache[cacheKey]
  }

  if (!client) {
    client = new CloudFormationClient({ region })
  }
  
  try {
    const command = new DescribeStackResourcesCommand({
      StackName: stackName
    })
    
    const response = await client.send(command)
    console.log('response', response)
    
    memoryCache[cacheKey] = response.StackResources
    return response.StackResources
  } catch (error) {
    console.error("Error fetching stack resources:", error)
    throw error
  }
}

if (require.main === module) {
  describeStackResources('test-service-for-manifest-plugin-dev', 'us-east-1').then((resources) => {
    console.log(resources)
  })
}

module.exports = {
  describeStackResources
}
