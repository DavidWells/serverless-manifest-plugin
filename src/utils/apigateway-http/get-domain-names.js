const { ApiGatewayV2Client, GetDomainNamesCommand, GetApiMappingsCommand } = require("@aws-sdk/client-apigatewayv2")
const { getAPIGatewayHttpDetails } = require("./get-api-details")
const safe = require('safe-await')

let client
let memoryCache = {}

/**
 * Retrieve domain names associated with an HTTP API Gateway
 * @param {string} apiId - The ID of the HTTP API
 * @param {string} region - AWS region of the API
 * @returns {Promise<{hasDomainMapping: boolean, domainName?: string}>}
 */
async function getHTTPApiDomainNames(apiId, region) {
  if (!client) {
    client = new ApiGatewayV2Client({ region })
  }

  const domainsCacheKey = `${apiId}-${region}-domains`
  const mappingsCacheKey = `${apiId}-${region}-mappings`

    /* Verify API exists */
  const [err, apiData] = await safe(getAPIGatewayHttpDetails(apiId, region))
  if (err) {
    console.error("Error fetching API details:", err)
    throw err
  }

  console.log('APIGatewayHttp details', apiData)

  try {
    // Check if domains are in cache, otherwise fetch them
    let domains = memoryCache[domainsCacheKey]
    if (!domains) {
      // Get all domain names for HTTP APIs
      const domainsCommand = new GetDomainNamesCommand({})
      const domainsResponse = await client.send(domainsCommand)
      domains = domainsResponse.Items || []
      memoryCache[domainsCacheKey] = domains
      console.log('Domains retrieved:', domains)
    } else {
      console.log('Using cached domains data')
    }
    
    // For each domain, check if it maps to our API
    for (const domain of domains) {
      const domainName = domain.DomainName
      
      // Check if mappings for this domain are in cache, otherwise fetch them
      let mappings = memoryCache[`${mappingsCacheKey}-${domainName}`]
      if (!mappings) {
        // Get API mappings for this domain
        const mappingsCommand = new GetApiMappingsCommand({
          DomainName: domainName
        })
        
        const mappingsResponse = await client.send(mappingsCommand)
        mappings = mappingsResponse.Items || []
        memoryCache[`${mappingsCacheKey}-${domainName}`] = mappings
        console.log('Mappings retrieved for domain:', domainName, mappings)
      } else {
        console.log('Using cached mappings data for domain:', domainName)
      }
      
      // Check if any mapping points to our API
      const hasMapping = mappings?.some(mapping => mapping.ApiId === apiId)
      
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
    console.error("Error checking HTTP API domain mappings:", error)
    throw error
  }
}

// Allow direct script execution
if (require.main === module) {
  const apiId = process.argv[2] || 'fxq2qfq15c'
  const region = process.argv[3] || 'us-west-1'
  
  getHTTPApiDomainNames(apiId, region)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
    })
    .catch((error) => {
      console.error('Error:', error)
      process.exit(1)
    })
}

module.exports = {
  getHTTPApiDomainNames
}