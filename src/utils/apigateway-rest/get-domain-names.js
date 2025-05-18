const { 
  APIGatewayClient, 
  GetDomainNamesCommand, 
  GetBasePathMappingsCommand,
  GetRestApiCommand
} = require("@aws-sdk/client-api-gateway")
const safe = require('safe-await')
const { getAPIGatewayRestDetails } = require("./get-api-details")

let client
let memoryCache = {}

async function getRestApiDomainNames(apiId, region) {

  const domainsCacheKey = `${apiId}-${region}-domains`
  const mappingsCacheKey = `${apiId}-${region}-mappings`

  if (!client) {
    client = new APIGatewayClient({ region })
  }

  /* Verify API exists */
  const [err, apiData] = await safe(getAPIGatewayRestDetails(apiId, region))
  if (err) {
    console.error("Error fetching API details:", err)
    throw err
  }
  
  /* Then get domain names */
  try {
    // Check if domains are in cache, otherwise fetch them
    let domains = memoryCache[domainsCacheKey]
    if (!domains) {
      // First get all domain names
      const domainsCommand = new GetDomainNamesCommand({})
      const domainsResponse = await client.send(domainsCommand)
      domains = domainsResponse.items
      memoryCache[domainsCacheKey] = domains
      console.log('domainsResponse', domains)
    } else {
      console.log('Using cached domains data')
    }
    
    // For each domain, check if it maps to our API
    for (const domain of domains) {
      const domainName = domain.domainName
      
      // Check if mappings for this domain are in cache, otherwise fetch them
      let mappings = memoryCache[`${mappingsCacheKey}-${domainName}`]
      if (!mappings) {
        // Get base path mappings for this domain
        const mappingsCommand = new GetBasePathMappingsCommand({
          domainName: domainName
        })
        
        const mappingsResponse = await client.send(mappingsCommand)
        mappings = mappingsResponse.items
        memoryCache[`${mappingsCacheKey}-${domainName}`] = mappings
        console.log('mappingsResponse', mappings)
      } else {
        console.log('Using cached mappings data for domain:', domainName)
      }
      
      // Check if any mapping points to our API
      const hasMapping = mappings?.some(mapping => mapping.restApiId === apiId)
      
      if (hasMapping) {
        return {
          hasDomainMapping: true,
          domainName: domainName
        }
      }
    }
    
    return {
      hasDomainMapping: false
    }
  } catch (error) {
    console.error("Error checking domain mappings:", error)
    throw error
  }
}

if (require.main === module) {
  const apiId = process.argv[2] || 'wf7phyuoj3'
  const region = process.argv[3] || 'us-east-1'
  getRestApiDomainNames(apiId, region).then((domainNames) => {
    console.log(domainNames)
  })
}

module.exports = {
  getRestApiDomainNames
}