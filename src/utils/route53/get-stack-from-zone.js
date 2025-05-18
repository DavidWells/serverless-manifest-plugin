const { CloudFormationClient, ListStacksCommand, DescribeStackResourcesCommand } = require("@aws-sdk/client-cloudformation")
const { Route53Client, ListResourceRecordSetsCommand } = require("@aws-sdk/client-route-53")
const { CloudFrontClient, ListDistributionsCommand } = require("@aws-sdk/client-cloudfront")
const { getRegionFromStackId } = require("../cloudformation/get-region-from-stack-id")
const { getCloudFormationConsoleUrl } = require("../cloudformation/get-cloudformation-console-url")

async function findStacksForDomainRecords(hostedZoneId, domainName) {
  const cfnClient = new CloudFormationClient()
  const route53Client = new Route53Client()
  const cloudFrontClient = new CloudFrontClient()
  
  // Get all record sets for the domain
  const recordsCommand = new ListResourceRecordSetsCommand({
    HostedZoneId: hostedZoneId
  })
  const records = await route53Client.send(recordsCommand)
  
  // Extract CloudFront distributions
  const distributionDomains = records.ResourceRecordSets
    .filter(record => record.Type === 'A' && record.AliasTarget?.DNSName.includes('cloudfront.net'))
    .map(record => record.AliasTarget.DNSName.replace(/\.$/, ''))
  
  // Get CloudFront distribution IDs
  const distributionsCommand = new ListDistributionsCommand({})
  const distributions = await cloudFrontClient.send(distributionsCommand)
  
  const distributionIds = distributions.DistributionList.Items
    .filter(dist => distributionDomains.includes(dist.DomainName))
    .map(dist => dist.Id)
  
  // Find stacks for these resources
  const stacksCommand = new ListStacksCommand({
    StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE']
  })
  const stacks = await cfnClient.send(stacksCommand)
  // console.log('stacks', stacks)
  
  const results = []
  
  for (const stack of stacks.StackSummaries) {
    try {
      const resourcesCommand = new DescribeStackResourcesCommand({
        StackName: stack.StackName
      })
      const resources = await cfnClient.send(resourcesCommand)
      
      // Check if stack has CloudFront distributions or Route53 records
      const hasMatchingResources = resources.StackResources.some(resource => 
        (resource.ResourceType === 'AWS::CloudFront::Distribution' && 
         distributionIds.includes(resource.PhysicalResourceId)) ||
        (resource.ResourceType === 'AWS::Route53::RecordSet' && 
         resource.PhysicalResourceId.includes(domainName))
      )
      
      if (hasMatchingResources) {
        const region = getRegionFromStackId(stack.StackId)
        results.push(Object.assign(stack, {
          region: region,
          consoleUrl: getCloudFormationConsoleUrl(region, stack.StackId)
        }))
      }
    } catch (error) {
      console.error(`Error checking stack ${stack.StackName}:`, error)
    }
  }
  
  return results
}

if (require.main === module) {
  findStacksForDomainRecords('Z03946072M30RLTT9L8Z4', 'davids-testing-domain.com').then((stacks) => {
    console.log("Associated stacks:", stacks)
  })
}

module.exports = {
  findStacksForDomainRecords
}