const { CloudFormationClient, GetTemplateCommand } = require("@aws-sdk/client-cloudformation")

async function getCloudFormationTemplate(stackName, region) {
  const client = new CloudFormationClient({ region })
  
  const command = new GetTemplateCommand({
    StackName: stackName
  })
  
  try {
    const response = await client.send(command)
    return response.TemplateBody
  } catch (error) {
    console.error("Error fetching template:", error)
    throw error
  }
}

if (require.main === module) {
  getCloudFormationTemplate('test-service-for-manifest-plugin-dev', 'us-east-1').then(template => {
    console.log(template)
  })
}

module.exports = {
  getCloudFormationTemplate
}