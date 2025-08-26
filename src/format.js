const fs = require('fs')
const os = require('os')
const path = require('path')
const safe = require('safe-await')
const { getDependencies, getShallowDeps } = require('./utils/getDeps')
const { getCloudFormationConsoleUrl } = require('./utils/cloudformation/get-cloudformation-console-url')
const { getFunctionUrlConfig, removeDuplicates } = require('./utils/get-function-url')
const { getAPIGatewayHttpUrl, getAPIGatewayHttpDetailsByLogicalId } = require('./utils/cloudformation/get-apigateway-http')
const { getAPIGatewayRestUrl, getAPIGatewayRestDetailsByLogicalId } = require('./utils/cloudformation/get-apigateway-rest')
const { getRestApiDomainNames } = require('./utils/apigateway-rest/get-domain-names')
const { getHTTPApiDomainNames } = require('./utils/apigateway-http/get-domain-names')
const { combineMatchingItems } = require('./utils/array')
const { getRegionFromArn, getFunctionNameFromArn, upperCase, upperCaseFirst } = require('./utils/string')
const { deepLog } = require('./utils/log')
const { describeStackResource } = require('./utils/cloudformation/describe-stack-resource')

async function getFormattedData(yaml = {}, stackOutput, srcDir, cfTemplateData, region, accountId) {
  let resources = {}
  let unknownResources = []
  if (yaml.resources && yaml.resources.Resources) {
    resources = yaml.resources.Resources
  }

  let outputs = {}
  if (yaml.resources && yaml.resources.Outputs) {
    outputs = yaml.resources.Outputs
  }

  // console.log('stackOutput', stackOutput)

  // Ensure accountId is a string
  if (accountId && typeof accountId !== 'string') {
    accountId = String(accountId)
  }
  
  // If accountId is an object or empty, set to empty string
  if (!accountId || typeof accountId === 'object') {
    accountId = ''
  }

  // Try to extract account ID from stack outputs if not provided
  if ((!accountId || accountId === '') && stackOutput && stackOutput.Outputs) {
    // Look for any ARN in the outputs to extract account ID
    for (const output of stackOutput.Outputs) {
      if (output.OutputValue && output.OutputValue.includes('arn:aws')) {
        const arnParts = output.OutputValue.split(':')
        if (arnParts.length >= 5) {
          accountId = arnParts[4]
          break
        }
      }
    }
  }
  const httpApiEndpoints = getApiGatewayHttpEndpoints(cfTemplateData.Resources)

  const apiEndpoints = getApiGatewayRestEndpoints(cfTemplateData.Resources)

  if (httpApiEndpoints.length) {
    // deepLog('combinedHttpApiRoutes', combinedHttpApiRoutes)
    httpApiEndpoints.forEach((route) => {
      apiEndpoints[route.resourceName] = route
    })
    // process.exit(0)
  }

  const foundLambdaFnUrls = getAllLambdaFunctionUrls(yaml, cfTemplateData, stackOutput)

  /* Get details about the lambda function urls */
  const foundLambdaFnUrlsDetails = await Promise.all(foundLambdaFnUrls.map(async (fn) => {
    if (fn.fnResource && fn.fnResource.logicalId) {
      const [resourceErr, resourceData] = await safe(
        describeStackResource(stackOutput.StackName, fn.fnResource.logicalId, region)
      )

      if (!resourceData) {
        console.log(`Warning: Lambda function ${fn.fnName} (${fn.fnResource.logicalId}) not found in stack ${stackOutput.StackName}`)
        unknownResources.push(fn.fnResource)
        return null
      }

      if (resourceData.arn) {
        return {
          arn: resourceData.arn,
          ...fn,
        }
      }

      console.log('resourceData', resourceData)
      return fn
    }
    return fn
  }))

  const validLambdaFnUrls = foundLambdaFnUrlsDetails.filter(Boolean)
  deepLog('verifiedLambdaFnUrls', validLambdaFnUrls)

  let deployedFunctionUrls = []
  if (validLambdaFnUrls && validLambdaFnUrls.length) {
    const deployedFunctionUrlsDetails = validLambdaFnUrls.map((fn) => {
      const name = (fn && fn.Properties && fn.Properties.FunctionName) ? fn.Properties.FunctionName : fn.fnName
      if (fn.url) {
        return fn
      }
      console.log('name', name)
      return getFunctionUrlConfig(name, getRegionFromArn(stackOutput.StackId))
    })

    deployedFunctionUrls = (await Promise.all(deployedFunctionUrlsDetails)).filter(Boolean)
    deepLog('resolved deployedFunctionUrls', deployedFunctionUrls)
    // process.exit(0)
  }

  if (deployedFunctionUrls && deployedFunctionUrls.length) {
    deployedFunctionUrls.forEach((fnUrlInfo) => {
      const functionName = fnUrlInfo.fnName
      const functionUrl = fnUrlInfo.url
      const resourceInfo = fnUrlInfo.fnResource || {}
      const methods = fnUrlInfo.methods || []
      deepLog('fnUrlInfo', fnUrlInfo)

      const set = {
        api: resourceInfo.logicalId,
        url: functionUrl,
        type: 'functionUrl',
        methods: methods,
        Properties: resourceInfo.Properties,
        resourceName: resourceInfo.logicalId
      }

      if (resourceInfo.logicalId) {
        apiEndpoints[resourceInfo.logicalId] = set
      }

      // apiEndpoints[functionName] = set
    })
  }
  deepLog('apiEndpoints', apiEndpoints)

  /* Now we are going to resolve the deployed urls */
  const urlKeys = Object.keys(apiEndpoints)
  console.log('urlKeys', urlKeys)

  const resolvedUrls = urlKeys.map(async (key) => {
    const endpoint = apiEndpoints[key]
    if (endpoint.type === 'apiGatewayHttp') {
      return getAPIGatewayHttpDetailsByLogicalId(stackOutput.StackName, endpoint.api, region)
    } else if (endpoint.type === 'apiGatewayRest') {
      return getAPIGatewayRestDetailsByLogicalId(stackOutput.StackName, endpoint.api, region)
    } else if (endpoint.type === 'functionUrl') {
      return endpoint
    }
  })

  const remoteAPIData = (await Promise.all(resolvedUrls))

  const nonFoundAPIResources = Array.from(new Set(urlKeys.map((key, i) => {
    const endpoint = apiEndpoints[key]
    if (!remoteAPIData[i].url) {
      return endpoint.api
    }
    return null
  }).filter(Boolean)))
  deepLog('nonFoundAPIResources', nonFoundAPIResources)

  deepLog('remoteAPIData', remoteAPIData)
  const allUrls = remoteAPIData.map((data) => {
    return data.url
  })
  deepLog('allUrls', allUrls)

  const apiMap = {}
  urlKeys.forEach((key, i) => {
    console.log('key', key)
    const endpoint = apiEndpoints[key]
    console.log('endpoint data', endpoint)
    const id = remoteAPIData[i].id || remoteAPIData[i].ApiId
    apiMap[endpoint.api] = {
      id: id,
      type: endpoint.type,
      baseUrl: allUrls[i],
      region: region,
      endpointCount: apiMap[endpoint.api] ? apiMap[endpoint.api].endpointCount + 1 : 1,
      // hasAuth
      isDeployed: Boolean(id)
    }
    apiEndpoints[key].url = allUrls[i] + (endpoint.path || '')
  })
  
  deepLog('apiMap', apiMap)
  // process.exit(0)

  // process.exit(0)

  // return

  const manifestUrlBase = {}

  const apiMapKeys = Object.keys(apiMap)
  if (apiMapKeys && apiMapKeys.length) {
    /* resolve domains */
    const domainPromises = apiMapKeys.map((key) => {
      const api = apiMap[key]
      console.log('api', api)
      // Only try to get domain names for REST APIs
      if (api.type === 'apiGatewayRest') {
        return getRestApiDomainNames(api.id, api.region)
      }
      if (api.type === 'apiGatewayHttp') {
        return getHTTPApiDomainNames(api.id, api.region)
      }

      // @TODO: Add support for cloudfront

      // @TODO: Add support for lambda function urls

      // For other types, return a default response
      return Promise.resolve({ hasDomainMapping: false })
    })

    const domains = await Promise.all(domainPromises)
    deepLog('domains', domains)

    apiMapKeys.forEach((key, i) => {
      const api = apiMap[key]
      if(domains[i].domainName) {
        if (api.baseUrl) {
          apiMap[key].rawBaseUrl = apiMap[key].baseUrl
          apiMap[key].baseUrl = replaceApiGatewayUrl(apiMap[key].baseUrl, 'https://' + domains[i].domainName )
        }
        apiMap[key].domainName = domains[i].domainName
      }
    })

    // deepLog('apiMap', apiMap)
    // process.exit(0)

    // deepLog('apiMapKeys', apiMapKeys)

    apiMapKeys.forEach((key) => {
      const api = apiMap[key]
      manifestUrlBase[`${key}`] = api.baseUrl
    })
  }

  const manifestUrls = Object.assign({}, manifestUrlBase, {
    apiGateway: '',
    apiGatewayBaseURL: '',
    httpApi: '',
    httpApiBaseURL: '',
    byPath: {},
    byFunction: {},
    byMethod: {}
  })

  // deepLog('manifestUrls', manifestUrls)
  // process.exit(0)

  let manifestData = Object.keys(yaml.functions).reduce((obj, functionName) => {
    const functionData = yaml.functions[functionName]
    const functionRuntime = getFunctionRuntime(functionData, yaml)
    const liveFunctionData = getFunctionData(functionName, stackOutput.Outputs)

    // Try to extract account ID from function ARN if still not found
    if ((!accountId || accountId === '') && liveFunctionData && liveFunctionData.OutputValue && 
        liveFunctionData.OutputValue !== 'Not deployed yet' && 
        liveFunctionData.OutputValue.includes('arn:aws')) {
      const arnParts = liveFunctionData.OutputValue.split(':')
      if (arnParts.length >= 5) {
        accountId = arnParts[4]
      }
    }

    if (liveFunctionData.OutputValue === 'Not deployed yet') {
      // Don't add non deployed functions to manifest
      return obj
    }

    const functionEvents = (functionData && functionData.events) ? functionData.events : []
    let functionDependencies = {}

    if (functionData.events) {
      const domainInfo = hasCustomDomain(yaml)
      const restAPIBaseURL = getRESTUrl(stackOutput.Outputs)
      const httpAPIBaseURL = getHTTPUrl(stackOutput.Outputs)
      if (domainInfo) {
        const customBasePath = domainInfo.basePath || ''
        obj.urls['apiGateway'] = formatURL(`https://${domainInfo.domainName}/${customBasePath}`)
      } else {
        obj.urls['apiGateway'] = restAPIBaseURL
      }

      // Set base url
      if (restAPIBaseURL) {
        obj.urls['apiGatewayBaseURL'] = restAPIBaseURL
      }
      if (httpAPIBaseURL) {
        obj.urls['httpApi'] = httpAPIBaseURL
        obj.urls['httpApiBaseURL'] = httpAPIBaseURL
      }

      // Set url byPath
      const dataByPath = functionData.events.reduce((acc, event) => {
        const httpEvent = isHttpTrigger(event)
        if (httpEvent) {
          const URI = getApiBaseUrl(event, obj)
          const hasPathValue = acc[`${httpEvent.path}`]
          let methods = [ upperCase(httpEvent.method) ]
          if (hasPathValue && hasPathValue.methods && hasPathValue.methods.length) {
            // combine methods
            methods = methods.concat(hasPathValue.methods)
          }
          const httpPath = formatPath(httpEvent.path)
          acc[`${httpPath}`] = {
            url: `${formatURL(URI)}${httpPath}`,
            methods: methods
          }
        }
        return acc
      }, obj.urls['byPath'])

      // console.log('dataByPath', dataByPath)

      obj.urls['byPath'] = dataByPath

      // Set url functionName
      const dataByFunction = functionData.events.reduce((acc, event) => {
        const httpEvent = isHttpTrigger(event)
        if (httpEvent) {
          const URI = getApiBaseUrl(event, obj)
          const hasPathValue = acc[`${functionName}`]
          let methods = [ upperCase(httpEvent.method) ]
          if (hasPathValue && hasPathValue.methods && hasPathValue.methods.length) {
            // combine methods
            methods = methods.concat(hasPathValue.methods)
          }
          const httpPath = formatPath(httpEvent.path)
          acc[`${functionName}`] = {
            url: `${formatURL(URI)}${httpPath}`,
            methods: methods
          }
        }
        return acc
      }, obj.urls['byFunction'])

      obj.urls['byFunction'] = dataByFunction

      const dataByMethod = functionData.events.reduce((acc, event) => {
        const httpEvent = isHttpTrigger(event)
        if (httpEvent) {
          const URI = getApiBaseUrl(event, obj)
          const METHOD = upperCase(httpEvent.method)
          const value = obj.urls['byMethod'][`${METHOD}`]
          const httpPath = formatPath(httpEvent.path)
          const url = `${formatURL(URI)}${httpPath}`
          let urls = [url]
          if (value && value.length) {
            urls = value.concat(url)
          }
          acc[`${METHOD}`] = urls
        }
        return acc
      }, {})

      obj.urls['byMethod'] = Object.assign({}, obj.urls['byMethod'], dataByMethod)

      // console.log('yaml.functions', yaml.functions[functionName])

      /* If runtime is node we can parse and list dependencies */
      // console.log('functionRuntime', functionRuntime)

      if (functionRuntime.match(/nodejs/)) {
        const functionPath = getFunctionPath(functionData, yaml, srcDir)
        const functionContent = fs.readFileSync(functionPath, 'utf8')

        const directDeps = getShallowDeps(functionContent)

        const [deps, pkgData] = getDependencies(functionPath, process.cwd())
        // console.log('deps', deps)
        // Collect all node modules uses
        const modules = Array.from(new Set(deps.map((dir) => {
          return dir.replace(process.cwd(), '')
        }).filter((d) => {
          // console.log('d', d)
          return d.match((/\/node_modules/))
        }).map((dir) => {
          const fileParts = path.dirname(dir).replace(/^\/node_modules\//, '').split('/')
          const moduleName = (fileParts[0].match(/^@/)) ? `${fileParts[0]}/${fileParts[1]}` : fileParts[0]
          return moduleName
        })))

        const modulesWithVersions = addDependencyVersions(modules, pkgData)

        const nestedModules = modules.filter((el) => {
          // Remove direct dependencies (which should be listed in package.json)
          return directDeps.indexOf(el) < 0
        })
        // console.log('directDeps', directDeps)
        functionDependencies = {
          direct: addDependencyVersions(directDeps, pkgData),
          nested: addDependencyVersions(nestedModules, pkgData),
        }
      }
    }

    // Format function triggers
    const removeList = ['resolvedMethod', 'resolvedPath']
    const eventTriggers = new Set()
    const functionEventTriggers = functionEvents.reduce((acc, event) => {
      const triggers = Object.keys(event)
      triggers.forEach((trigger) => {
        eventTriggers.add(trigger)
      })
      return Array.from(eventTriggers)
    }, []).filter((item) => {
      return !removeList.includes(item)
    })

    const finalFunctionData = {
      [`${functionName}`]: {
        name: getFunctionNameFromArn(liveFunctionData.OutputValue),
        description: functionData.description || '',
        arn: liveFunctionData.OutputValue,
        runtime: functionRuntime,
        triggers: functionEventTriggers,
        dependencies: functionDependencies
      }
    }

    // functions and arns
    const funcObj = obj['functions'] || {}
    // Assign to reducer
    obj['functions'] = Object.assign({}, funcObj, finalFunctionData)

    // Add API endpoints to manifest data
    obj.endpoints = apiEndpoints

    return obj
  }, {
    metadata: {
      manifestUpdated: new Date().toISOString(),
      region: region || '', // Add region as a top-level key
      accountId: accountId || '', // Add account ID as a top-level key right after region (always a string)
      stack: {
        id: stackOutput.StackId || '',
        name: stackOutput.StackName || '',
        status: stackOutput.StackStatus || '',
        description: stackOutput.Description || '',
        creationTime: stackOutput.CreationTime ? new Date(stackOutput.CreationTime).toISOString() : '',
        lastUpdatedTime: stackOutput.LastUpdatedTime ? new Date(stackOutput.LastUpdatedTime).toISOString() : '',
        tags: stackOutput.Tags || [],
        terminationProtection: stackOutput.EnableTerminationProtection || false,
        consoleUrl: getCloudFormationConsoleUrl(region, stackOutput.StackId)
      }
    },
    apis: apiMap,
    urls: manifestUrls,
    functions: {},
    outputs: stackOutput.Outputs,
  })

  // console.log('manifestData', Object.keys(manifestData))
  // process.exit(0)

  if (apiEndpoints) {
    manifestData = Object.keys(apiEndpoints).reduce((obj, endpointName) => {
      const endpointData = apiEndpoints[endpointName]
      console.log('endpointData', endpointData)
      const methods = endpointData.methods || []

      // add endpoints to manifestData byPath
      const byPath = obj.urls['byPath']
      byPath[endpointData.path || endpointData.url] = endpointData

      // Add endpoints to byMethod
      const byMethod = obj.urls['byMethod']
      methods.forEach((endpointMethod) => {
        const method = endpointMethod.httpMethod
        const fullUrl = endpointData.url + (endpointData.path || '')
        byMethod[method] = byMethod[method] ? byMethod[method].concat(fullUrl) : [fullUrl]
      })

      // obj.endpoints[endpointName] = apiEndpoints[endpointName]
      return obj
    }, manifestData)
  }

  if (deployedFunctionUrls && deployedFunctionUrls.length) {
    // const x = deployedFunctionUrls.reduce((acc, fnUrlInfo) => {
    //   // acc[fn.fnName] = fn
    //   // console.log('fnUrlInfo', fnUrlInfo)
    //   return acc
    // }, manifestData)
    // console.log('x', x)
  }

  if (unknownResources.length) {
    console.log('unknownResources', unknownResources)
  }

  return manifestData
}


function getApiGatewayHttpEndpoints(resources) {
  const httpApiRoutes = []

  // Find associated methods for this resource
  Object.entries(resources).forEach(([resourceName, resource]) => {
    if (resource.Type === 'AWS::ApiGatewayV2::Route') {
      const httpApiId = resolveHttpApiId(resource.Properties || {})
      const path = resource.Properties.RouteKey.split(' ')[1]
      const methodString = resource.Properties.RouteKey.split(' ')[0]
      const method = {
        httpMethod: methodString,
        ...resource.Properties,
        // authorizationType: methodResource.Properties.AuthorizationType,
        // apiKeyRequired: methodResource.Properties.ApiKeyRequired || false
      }
      const endpoint = {
        api: httpApiId,
        url: '',
        path,
        type: 'apiGatewayHttp',
        methods: [method],
        // ApiId: httpApiId,
        resourceName,
      }

      httpApiRoutes.push(endpoint)
    }
  })
  // deepLog('httpApiRoutes', httpApiRoutes)

  const combinedHttpApiRoutes = combineMatchingItems(httpApiRoutes)

  return combinedHttpApiRoutes
}

// Add dependency versions to package names
function addDependencyVersions(array, pkgData) {
  // return array.map((name) => {
  //   if (!pkgData[name] || !pkgData[name]._from) {
  //     return name
  //   }
  //   const from = pkgData[name]._from
  //   const pkgWithVersion = from.match(/@/) ? from : `${from}@${pkgData[name].version}`
  //   return pkgWithVersion
  // })
  return array.map((name) => {
    if (!pkgData[name]) {
      return name
    }
    const version = pkgData[name].version
    return `${name}@${version}`
  })
}


function evaluateEnabled(enabled) {
  if (enabled === undefined) {
    return true;
  }
  if (typeof enabled === "boolean") {
    return enabled;
  } else if (typeof enabled === "string" && enabled === "true") {
    return true;
  } else if (typeof enabled === "string" && enabled === "false") {
    return false;
  }
  return false
}

function hasCustomDomain(yaml = {}) {
  const { plugins, custom } = yaml
  if (
      hasPlugin(plugins, 'serverless-domain-manager') &&
      custom && custom.customDomain && custom.customDomain.domainName &&
      evaluateEnabled(custom.customDomain.enabled)
    ) {
    return custom.customDomain
  }
  return false
}

function hasPlugin(plugins, name) {
  if (!plugins || plugins.length === 0) {
    return false
  }
  return plugins.includes(name)
}

function getApiGatewayRestEndpoints(resources) {
  const apiEndpoints = {}
  
  // Helper function to get full path by traversing parents
  function getFullPath(resource, resources) {
    const pathParts = [resource.Properties.PathPart]
    let currentResource = resource
    
    // Keep traversing up until we hit the root resource
    while (currentResource.Properties.ParentId) {
      const parentId = currentResource.Properties.ParentId.Ref || currentResource.Properties.ParentId['Fn::GetAtt']?.[0]
      // console.log('parentId', parentId)
      if (!parentId) break
      
      let parentResource = resources[parentId]
      if (!parentResource) break
      
      pathParts.unshift(parentResource.Properties.PathPart)
      currentResource = parentResource
    }
    
    return pathParts.join('/') // .replace(/^\//, '')
  }

  // First pass: collect all resources and their full paths
  Object.entries(resources).forEach(([resourceName, resource]) => {
    /*
    console.log('resourceName', resourceName, resource.Type)
    /** */
    if (resource.Type === 'AWS::ApiGateway::Resource') {
      const restApiId = resolveRestApiId((resource.Properties || {}))
      // console.log('restApiId', restApiId)
      const endpoint = {
        api: restApiId,
        url: '',
        path: getFullPath(resource, resources),
        type: 'apiGatewayRest',
        methods: [],
        // RestApiId: restApiId
      }
      
      // Find associated methods for this resource
      Object.entries(resources).forEach(([methodName, methodResource]) => {
        if (
            methodResource.Type === 'AWS::ApiGateway::Method' && 
            // TODO match strings too
            methodResource.Properties.ResourceId.Ref === resourceName
          ) {
          
          const method = {
            httpMethod: methodResource.Properties.HttpMethod,
            authorizationType: methodResource.Properties.AuthorizationType,
            apiKeyRequired: methodResource.Properties.ApiKeyRequired || false
          }
          
          // Add integration details if present
          if (methodResource.Properties.Integration) {
            method.integration = {
              type: methodResource.Properties.Integration.Type,
              uri: methodResource.Properties.Integration.Uri || null,
              httpMethod: methodResource.Properties.Integration.IntegrationHttpMethod || null
            }
          }

          if (method.httpMethod !== 'OPTIONS') {
            endpoint.methods.push(method)
          }
        }
      })
      
      if (endpoint.methods.length) {
        apiEndpoints[resourceName] = endpoint
      }
    } else if (resource.Type === 'AWS::ApiGatewayV2::Route') {
      // http api routes
    }
  })
  // deepLog('httpApiRoutes', httpApiRoutes)
  

  // deepLog('apiEndpoints', apiEndpoints)
  // process.exit(0)
  // console.log('apiEndpoints', apiEndpoints)
  return apiEndpoints
}

/*
{
  OutputKey: 'YoLambdaFunctionUrl',
  OutputValue: 'https://hk62gqtwbu7q3pfzs67y5eqfay0klxep.lambda-url.us-west-2.on.aws/',
  Description: 'Lambda Function URL',
  ExportName: 'sls-test-service-for-manifest-plugin-dev-YoLambdaFunctionUrl'
}
*/
function getAllLambdaFunctionUrls(serverlessConf, compiledCf, stackOutput) {
  const outputs = stackOutput.Outputs || []
  const stackName = stackOutput.StackName || ''

  /* Check serverless.yml for functions with url property */
  let fnsWithUrls = []
  if (serverlessConf.functions) {
    const fns = Object.keys(serverlessConf.functions)
    // console.log('fns', fns)
    fnsWithUrls = fns.filter((fn) => {
      const fnData = serverlessConf.functions[fn]
      // console.log('fnData', fnData)
      return fnData && fnData.hasOwnProperty('url')
    }).map((fn) => {
      if (serverlessConf.functions[fn] && serverlessConf.functions[fn].hasOwnProperty('name')) {
        return {
          fnName: serverlessConf.functions[fn].name,
          fnConfig: serverlessConf.functions[fn],
          via: 'serverless.yml function config'
        }
      }
      return serverlessConf.functions[fn]
    })
    deepLog('serverless.yml functions with urls', fnsWithUrls)
  }

  /* Check stack outputs for lambda function urls */
  const fromOutputs = outputs.filter((output) => {
    return output.OutputKey.match(/FunctionUrl$/) && output.OutputValue && output.OutputValue.match(/lambda-url/)
  }).map((output) => {
    // Find YoLambdaFunctionUrl
    const resources = compiledCf.Resources || {}
    const functionUrlDetails = resources[output.OutputKey] || {}
    const functionProperties = functionUrlDetails.Properties || {}
    const aproxFnName = output.OutputKey.replace(/LambdaFunctionUrl$/, '')
    // lower case first letter
    const fnNameLower = aproxFnName.charAt(0).toLowerCase() + aproxFnName.slice(1)
    let resolvedFnName = functionProperties.FunctionName

    const fnDetails = resolveFunction(functionUrlDetails, compiledCf)
    
    if (!resolvedFnName) {
      if (serverlessConf.functions && serverlessConf.functions[fnNameLower]) {
        resolvedFnName = stackOutput.StackName + '-' + fnNameLower
      } else if (serverlessConf.functions && serverlessConf.functions[aproxFnName]) {
        resolvedFnName = stackOutput.StackName + '-' + aproxFnName
      }
    }

    return {
      fnName: resolvedFnName, 
      url: output.OutputValue,
      fnUrlResource: Object.assign({
        logicalId: output.OutputKey,
      }, functionUrlDetails),
      fnResource: Object.assign({
        logicalId: fnDetails[0],
      }, fnDetails[1]),
      via: 'stack outputs'
    }
  })
  deepLog('fromOutputs', fromOutputs)

  /* Check stack resources for lambda function urls */
  const fromResources = Object.keys(compiledCf.Resources).filter((resource) => {
    return compiledCf.Resources[resource].Type === 'AWS::Lambda::Url'
  }).map((resource) => {
    const resourceDetails = compiledCf.Resources[resource] || {}
    const resourceProperties = resourceDetails.Properties || {}
    const fnDetails = resolveFunction(resourceDetails, compiledCf)
    if (typeof fnDetails === 'string') {
      return {
        fnName: fnDetails,
        logicalId: resource,
        via: 'compiledCf outputs arn string'
      }
    } else if (fnDetails[1] && fnDetails[1].Properties && fnDetails[1].Properties.FunctionName && typeof fnDetails[1].Properties.FunctionName === 'string') {
      return Object.assign({
        fnName: fnDetails[1].Properties.FunctionName,
        fnResource: Object.assign({
          logicalId: fnDetails[0],
        }, fnDetails[1]),
        via: 'compiledCf outputs function logical resource'
      })
    }
    return fnDetails
  })

  deepLog('fromResources', fromResources)

  const foundFnsWithUrls = fromOutputs.concat(fromResources).concat(fnsWithUrls)
  deepLog('foundFnsWithUrls', foundFnsWithUrls)

  // remove duplicates name and Properties.FunctionName
  const uniqueFnsWithUrls = removeDuplicates(foundFnsWithUrls)
  deepLog('uniqueFnsWithUrls', uniqueFnsWithUrls)


  const formatted = uniqueFnsWithUrls.map((fn) => {
    if (
        fn.fnUrlResource && fn.fnUrlResource.Properties 
        && fn.fnUrlResource.Properties.Cors &&  
        fn.fnUrlResource.Properties.Cors.AllowMethods
      ) {
      fn.methods = fn.fnUrlResource.Properties.Cors.AllowMethods.map((method) => {
        return { httpMethod: method }
      })
    }
    return fn
  })
  // const resourceInfo = await getResourceInfo("tester-xyz-user-service-prod", "CustomResourceDelayFunction", "us-east-1")
  // console.log('resourceInfo', resourceInfo)
  return formatted
}

/**
 * Replace AWS API Gateway URL with a custom domain
 * 
 * @param {string} originalUrl - The original AWS API Gateway URL
 * @param {string} customDomain - The custom domain to replace the AWS endpoint
 * @returns {string} - The transformed URL with the custom domain
 */
function replaceApiGatewayUrl(originalUrl, customDomain) {
  try {
    // Parse the original URL
    const url = new URL(originalUrl);
    
    // Remove the execute-api.region.amazonaws.com part
    const newUrl = new URL(customDomain);
    
    // Preserve the path, including stage (if any)
    // newUrl.pathname = url.pathname;
    
    return newUrl.toString();
  } catch (error) {
    console.error('Error replacing URL:', error);
    throw error;
  }
}

function resolveRestApiId(properties) {
  if (typeof properties.RestApiId === 'string') {
    return properties.RestApiId
  }
  if (properties.RestApiId.Ref) {
    return properties.RestApiId.Ref
  }
  if (properties.RestApiId['Fn::GetAtt'] && properties.RestApiId['Fn::GetAtt'].length === 2 && properties.RestApiId['Fn::GetAtt'][1] === 'Id') {
    return properties.RestApiId['Fn::GetAtt']?.[0]
  }

  throw new Error('Could not resolve RestApiId')
}

function resolveHttpApiId(properties) {
  if (typeof properties.ApiId === 'string') {
    return properties.ApiId
  }
  if (properties.ApiId.Ref) {
    return properties.ApiId.Ref
  }
  if (properties.ApiId['Fn::GetAtt'] && properties.ApiId['Fn::GetAtt'].length === 2 && properties.ApiId['Fn::GetAtt'][1] === 'Id') {
    return properties.ApiId['Fn::GetAtt']?.[0]
  }

  throw new Error('Could not resolve HttpApiId')
}


function resolveFunction(resourceDetails, compiledCf) {
  if (typeof resourceDetails === 'string') {
    return resourceDetails
  }
  const functionProperties = resourceDetails.Properties || {}
  if (resourceDetails && functionProperties && functionProperties.TargetFunctionArn) {
    if (
        typeof functionProperties.TargetFunctionArn == 'string' && 
        functionProperties.TargetFunctionArn.includes('arn:aws:lambda')
      ) {
      return [ undefined, getFunctionNameFromArn(functionProperties.TargetFunctionArn) ]
    }
    const targetDetails = functionProperties.TargetFunctionArn
    if (targetDetails) {
      if (targetDetails['Fn::GetAtt'] && targetDetails['Fn::GetAtt'].length === 2 && targetDetails['Fn::GetAtt'][1] === 'Arn') {
        const logicalId = targetDetails['Fn::GetAtt'][0]
        const fnResource = compiledCf.Resources[logicalId]
        return [logicalId, fnResource]
      } else if (targetDetails.Ref) {
        const fnResource = compiledCf.Resources[targetDetails.Ref]
        return [targetDetails.Ref, fnResource]
      }
    }
  }
}

function getFunctionRuntime(functionData = {}, serverlessConf = {}) {
  if (functionData.runtime) {
    return functionData.runtime
  }
  if (serverlessConf.provider && serverlessConf.provider.runtime) {
    return serverlessConf.provider.runtime
  }
  return 'NA'
}

function getFunctionRuntimeExtension(runtime) {
  let extension = '.js'
  if (runtime.match(/nodejs/)) {
    extension = '.js'
  } else if (runtime.match(/python/)) {
    extension = '.py'
  } else if (runtime.match(/go/)) {
    extension = '.go'
  } else if (runtime.match(/java/)) {
    extension = '.jar'
  }
  return extension
}

function getFunctionPath(functionData, yaml, directory) {
  const dir = directory || process.cwd()
  if (!functionData.handler) {
    throw new Error(`Handler missing from function. ${JSON.stringify(functionData)}`)
  }
  const runtime = getFunctionRuntime(functionData, yaml)

  const extension = getFunctionRuntimeExtension(runtime)

  // todo support other langs ^
  const funcPath = `${functionData.handler.split('.').slice(0, -1).join('.')}${extension}`
  const relativePath = funcPath.replace('~', os.homedir())
  let fullFilePath = (path.isAbsolute(relativePath) ? relativePath : path.join(dir, relativePath))
  if (fs.existsSync(fullFilePath)) {
    // Get real path to handle potential symlinks (but don't fatal error)
    fullFilePath = fs.realpathSync(fullFilePath)
  // Only match files that are relative
  }
  if (!fs.existsSync(fullFilePath)) {
    throw new Error(`File "${funcPath}" not found. ${fullFilePath} missing`)
  }
  return fullFilePath
}

function getRESTUrl(outputs = []) {
  return outputs.reduce((acc, curr) => {
    if (curr.OutputKey === 'ServiceEndpoint') {
      return curr.OutputValue
    }
    return acc
  }, '')
}

function getHTTPUrl(outputs = []) {
  return outputs.reduce((acc, curr) => {
    if (curr.OutputKey === 'HttpApiUrl') {
      return curr.OutputValue
    }
    return acc
  }, '')
}


// ZazLambdaFunctionQualifiedArn
function getFunctionData(functionName, outputs) {
  const liveFunctionData = outputs.filter((out) => {
    return `${upperCaseFirst(functionName)}` === out.OutputKey.replace('LambdaFunctionQualifiedArn', '')
  })

  if (liveFunctionData && liveFunctionData.length) {
    return liveFunctionData[0]
  }

  return {
    OutputKey: 'UnDeployedLambdaFunctionArn',
    OutputValue: 'Not deployed yet',
    Description: 'Draft Lambda function'
  }
}


function getApiBaseUrl(event, serviceInfo) {
  if (event.http) {
    return serviceInfo.urls['apiGateway'] || serviceInfo.urls['apiGatewayBaseURL']
  }
  return serviceInfo.urls['httpApi'] || serviceInfo.urls['httpApiBaseURL']
}

function isHttpTrigger(event) {
  return event.http || event.httpApi
}

function formatURL(uri) {
  return uri.replace(/\/$/, '')
}

function formatPath(uri) {
  return `/${uri.replace(/^\//, '')}`
}


module.exports = {
  getFormattedData
}