const { CloudFormationClient, DescribeStackResourceCommand } = require("@aws-sdk/client-cloudformation")
const { getFunctionUrlConfig } = require("./get-function-url")

async function getResourceInfo(stackName, logicalId, region) {
  const client = new CloudFormationClient({ region: region })
  
  try {
    const command = new DescribeStackResourceCommand({
      StackName: stackName,
      LogicalResourceId: logicalId
    })
    
    const response = await client.send(command)
    /*
    console.log('response', response)
    /** */
    return response.StackResourceDetail
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404) {
      return null
    }
    console.error("Error fetching resource info:", error)
    throw error
  }
}

// Usage
async function getFunctionUrlConfigFromStack(stackName, logicalId, region) {
  const resourceInfo = await getResourceInfo(stackName, logicalId, region)
  
  if (resourceInfo) {
    console.log("Resource Type:", resourceInfo.ResourceType)
    console.log("Physical ID:", resourceInfo.PhysicalResourceId)
    console.log("Status:", resourceInfo.ResourceStatus)
    console.log("Last Updated:", resourceInfo.LastUpdatedTimestamp)
    const functionUrlConfig = await getFunctionUrlConfig(resourceInfo.PhysicalResourceId, region)
    console.log("Function URL Config:", functionUrlConfig)
    return functionUrlConfig
  } else {
    console.log("Resource not found")
  }
}

/*
getResourceInfo('tester-xyz-user-service-prod', 'CustomResourceDelayFunction', 'us-east-1').then((resourceInfo) => {
  console.log('resourceInfo', resourceInfo)
})

//  getFunctionUrlConfigFromStack(resourceInfo.StackName, resourceInfo.LogicalResourceId, resourceInfo.Region)
// process.exit(1)
/** */

module.exports = { getResourceInfo, getFunctionUrlConfigFromStack }