const { 
  ApiGatewayV2Client, 
  GetDomainNamesCommand,
  GetApiMappingsCommand
} = require("@aws-sdk/client-apigatewayv2")

async function verifyDomainMapping(domainName, region) {
  const client = new ApiGatewayV2Client({ region })

  try {
    // Get domain details
    const domainCommand = new GetDomainNamesCommand({})
    const domainResponse = await client.send(domainCommand)
    
    // Find the specific domain
    const matchedDomain = domainResponse.Items?.find(
      domain => domain.DomainName === domainName
    )

    if (!matchedDomain) {
      console.log(`No domain found matching ${domainName}`)
      return null
    }

    // Get API mappings for this domain
    const mappingsCommand = new GetApiMappingsCommand({
      DomainName: domainName
    })
    
    const mappingsResponse = await client.send(mappingsCommand)
    
    console.log('Domain Details:', JSON.stringify(matchedDomain, null, 2))
    console.log('API Mappings:', JSON.stringify(mappingsResponse.Items, null, 2))
    
    let route53Record
    if (matchedDomain.DomainNameConfigurations && matchedDomain.DomainNameConfigurations.length === 1) {
      route53Record = matchedDomain.DomainNameConfigurations[0].ApiGatewayDomainName
    }
    return {
      route53Record: route53Record,
      domain: matchedDomain,
      mappings: mappingsResponse.Items
    }
  } catch (error) {
    console.error('Error verifying domain:', error)
    throw error
  }
}

// Usage example
if (require.main === module) {
  const domainName = process.argv[2] || 'api.cognitoguide.com'
  const region = process.argv[3] || 'us-west-1'
  
  verifyDomainMapping(domainName, region)
    .then(result => {
      if (result) {
        console.log('Domain verification complete.', result)
      }
    })
    .catch(console.error)
}

module.exports = { verifyDomainMapping }