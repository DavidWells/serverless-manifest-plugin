const fs = require('fs')
const os = require('os')
const path = require('path')
const { promisify } = require('util')
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)
const { ensureGitIgnore } = require('./utils/gitignore')
const { getDependencies, getShallowDeps } = require('./utils/getDeps')

class ServerlessManifestPlugin {
  constructor(serverless, options) {
    this.serverless = serverless
    this.options = options
    this.commands = {
      manifest: {
        usage: 'Generate a serverless service manifest file',
        lifecycleEvents: [
          'create'
        ],
        options: {
          json: {
            usage: 'Output json only for programmatic usage',
            type: 'boolean',
          },
          silent: {
            usage: 'Silence all console output during manifest creation',
            type: 'boolean',
          },
          output: {
            usage: 'Output path for serverless manifest file. Default /.serverless/manifest.json',
            shortcut: 'o',
            type: 'string',
          },
          disableOutput: {
            usage: 'Disable manifest.json from being created',
            shortcut: 'd',
            type: 'boolean',
          },
          postProcess: {
            usage: 'Path to custom javascript function for additional processing',
            shortcut: 'p',
            type: 'string',
          },
          location:{
            usage: 'Path to serverless root.  Default process.cwd()',
            shortcut: 'l',
            type: 'string',
          }
        },
      },
    }

    this.hooks = {
      /* expose `sls manifest` command */
      'manifest:create': this.generateManifest.bind(this),
      /* TODO Add special output here */
      // 'after:info:info': this.runInfo.bind(this),
    }
    const { disablePostDeployGeneration } = getCustomSettings(this.serverless)
    if (!disablePostDeployGeneration) {
      /* create manifest after deploy */
      this.hooks['after:deploy:finalize'] = this.generateManifest.bind(this)
      /* create manifest after single function deploy */
      // this.hooks['after:deploy:function:deploy'] = this.generateManifest.bind(this)
    }
  }
  runInfo() {
    // TODO
  }

  /**
   * Retrieves the data from a given serverless configuration
   *
   * @param {string} srcPath - The path to the function code
   * @returns {Promise<unknown>}
   */
  getData(srcPath) {
    var name = this.serverless.service.getServiceName()
    var provider = this.serverless.getProvider('aws')
    var stage = provider.getStage()
    var region = provider.getRegion()
    var stackName = provider.naming.getStackName()
    var params = { StackName: `${stackName}` }

    return new Promise((resolve, reject) => {
      provider.request('CloudFormation', 'describeStacks', params, stage, region)
        .then((data) => {
          var stack = data.Stacks.pop() || { Outputs: [] }
          var manifestData = getFormattedData(this.serverless.service, stack, srcPath)
          var stageData = {}
          stageData[stage] = manifestData
          resolve(stageData)
        })
    })
  }
  /* Runs after `serverless deploy` */
  async generateManifest() {
    const customOpts = getCustomSettings(this.serverless)
    const outputInJson = customOpts.json || this.options.json
    const disableFileOutput = customOpts.disableOutput || this.options.disableOutput
    const silenceLogs = customOpts.silent || this.options.silent || outputInJson
    const handlePostProcessing = customOpts.postProcess || this.options.postProcess
    const customOutputPath = customOpts.output || this.options.output
    /*
    Allows for customising where the manifest looks for function code
     */
    const srcPath = customOpts.srcPath || this.options.srcPath || process.cwd()

    if (!silenceLogs) {
      console.log(`● Creating Serverless manifest...\n`)
    }

    if (disableFileOutput && !handlePostProcessing) {
        console.log('No manifest data processed or saved. "disableOutput" is true & no "postProcess" option is set')
        console.log(' Make sure you create a function to handle your manifest data')
        console.log(' Example:')
        console.log('  postProcess: ./my-file-to-process.js')
      return false
    }

    /* Fetch live service data */
    const stageData = await this.getData(srcPath)

    const cwd = srcPath
    const dotServerlessFolder = path.join(cwd, '.serverless')
    const defaultManifestPath = path.join(dotServerlessFolder, 'manifest.json')

    let manifestPath = path.join(dotServerlessFolder, 'manifest.json')
    if (customOutputPath) {
      manifestPath = path.resolve(customOutputPath)
    }
    // console.log('manifestPath', manifestPath)

    const currentManifest = getManifestData(manifestPath)
    // console.log('currentManifest', currentManifest)
    // merge together values. TODO deep merge
    const manifestData = Object.assign({}, currentManifest, stageData)
    // console.log('manifestData', manifestData)
    let finalManifest = manifestData

    /* Allow for custom postprocessing of manifest data */
    if (handlePostProcessing) {
      try {
        finalManifest = await runPostManifest(handlePostProcessing, manifestData, {
          disableLogs: silenceLogs
        })
      } catch (err) {
        console.log('Error in manifest postProcess...')
        throw err
      }
    }

    /* Write to output file */
    if (!disableFileOutput) {
      try {
        if (!silenceLogs) {
          console.log('● Saving Serverless manifest file...\n')
        }
        await saveManifest(manifestData, manifestPath)
        if (!silenceLogs) {
          console.log(`✓ Save manifest complete`)
          console.log(` Output path: ${manifestPath.replace(cwd, '')}`)
          console.log(` Full path:   ${manifestPath}`)
        }
      } catch (err) {
        console.log('Error during serverless manifest saving...')
        throw err
      }
    }

    // Output JSON for further processing with jq
    if (outputInJson) {
      console.log(JSON.stringify(finalManifest, null, 2))
    }
  }
}

async function saveManifest(manifestData, manifestPath) {
  const cwd = process.cwd()
  const parentDir = path.dirname(manifestPath)
  if (!fsExistsSync(parentDir)) {
    fs.mkdirSync(parentDir)
  }
  const data = JSON.stringify(manifestData, null, 2)
  fs.writeFileSync(manifestPath, data)
  // Ensure git ignore added
  await ensureGitIgnore(cwd)
}

function getCustomSettings(serverless) {
  const { service } = serverless || {}
  return service && service.custom && service.custom.manifest || {}
}

function getManifestData(filePath) {
  if (fsExistsSync(filePath)) {
    const configValues = fs.readFileSync(filePath, 'utf8')
    if (configValues) {
      return JSON.parse(configValues)
    }
  }
  // else return empty object
  return {}
}

function getFormattedData(yaml = {}, stackOutput, srcDir) {
  let resources = {}
  if (yaml.resources && yaml.resources.Resources) {
    resources = yaml.resources.Resources
  }

  let outputs = {}
  if (yaml.resources && yaml.resources.Outputs) {
    outputs = yaml.resources.Outputs
  }

  const manifestData = Object.keys(yaml.functions).reduce((obj, functionName) => {
    const functionData = yaml.functions[functionName]
    const functionRuntime = getFunctionRuntime(functionData, yaml)
    const liveFunctionData = getFunctionData(functionName, stackOutput.Outputs)

    if (liveFunctionData.OutputValue === 'Not deployed yet') {
      // Don't add undeployed functions to manifest
      return obj
    }

    const functionEvents = (functionData && functionData.events) ? functionData.events : []
    let functionDependancies = {}

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

      /* If runtime is node we can parse and list dependancies */
      // console.log('functionRuntime', functionRuntime)

      if (functionRuntime.match(/nodejs/)) {
        const functionPath = getFunctionPath(functionData, yaml, srcDir, functionName)
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

        const modulesWithVersions = addDependancyVersions(modules, pkgData)

        const nestedModules = modules.filter((el) => {
          // Remove direct dependencies (which should be listed in package.json)
          return directDeps.indexOf(el) < 0
        })
        // console.log('directDeps', directDeps)
        functionDependancies = {
          direct: addDependancyVersions(directDeps, pkgData),
          nested: addDependancyVersions(nestedModules, pkgData),
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
        arn: liveFunctionData.OutputValue,
        runtime: functionRuntime,
        triggers: functionEventTriggers,
        dependancies: functionDependancies
      }
    }

    // functions and arns
    const funcObj = obj['functions'] || {}
    // Assign to reducer
    obj['functions'] = Object.assign({}, funcObj, finalFunctionData)

    return obj
  }, {
    urls: {
      apiGateway: '',
      apiGatewayBaseURL: '',
      httpApi: '',
      httpApiBaseURL: '',
      byPath: {},
      byFunction: {},
      byMethod: {}
    },
    functions: {},
    outputs: stackOutput.Outputs
    // TODO remove sensitive data from resources
    // resources: resources
  })

  return manifestData
}

async function runPostManifest(filePath, manifestData, opts = {}) {
  const { disableLogs } = opts
  const realPath = path.resolve(filePath)
  const fileContents = fs.readFileSync(realPath, 'utf-8')
  const fileDirectory = path.dirname(realPath)
  const fileType = path.extname(realPath)
  let jsFile
  let returnValue = manifestData
  let originalConsoleLog = console.log
  if (disableLogs) {
    // disable logging in postProcess file
    console.log = () => {}
  }
  try {
    jsFile = require(realPath)
    if (jsFile && typeof jsFile === 'function') {
      console.log(`● Running Serverless manifest postProcessing from "${filePath}"...\n`)
      const value = await jsFile(manifestData)
      console.log()
      if (value && isObject(value)) {
        returnValue = value
      }
      console.log(`✓ PostProcessing complete\n`)
      if (disableLogs) {
        // restore logging
        console.log = originalConsoleLog
      }
    } else {
      throw new Error(`${realPath} must export a default function for manifest post processing`)
    }
  } catch (err) {
    if (disableLogs) {
      // restore logging
      console.log = originalConsoleLog
    }
    throw new Error(err)
  }
  return returnValue
}

function upperCase(str) {
  return str.toUpperCase()
}

// is plain object
function isObject(obj) {
  if (typeof obj !== 'object' || obj === null) return false

  let proto = obj
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto)
  }

  return Object.getPrototypeOf(obj) === proto
}

// Add dependency versions to package names
function addDependancyVersions(array, pkgData) {
  return array.map((name) => {
    if (!pkgData[name] || !pkgData[name]._from) {
      return name
    }
    const from = pkgData[name]._from
    const pkgWithVersion = from.match(/@/) ? from : `${from}@${pkgData[name].version}`
    return pkgWithVersion
  })
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
  if (hasPlugin(plugins, 'serverless-domain-manager') &&
      custom && custom.customDomain && custom.customDomain.domainName &&
      evaluateEnabled(custom.customDomain.enabled)) {
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

function getFunctionPath(functionData, yaml, directory, functionName) {
  const funcBaseDir = getFunctionBaseDir(directory, yaml, functionName)
  if (!functionData.handler) {
    throw new Error(`Handler missing from function. ${JSON.stringify(functionData)}`)
  }
  const runtime = getFunctionRuntime(functionData, yaml)

  const extension = getFunctionRuntimeExtension(runtime)

  // todo support other langs ^
  const funcPath = `${functionData.handler.split('.').slice(0, -1).join('.')}${extension}`
  const relativePath = funcPath.replace('~', os.homedir())
  let fullFilePath = (path.isAbsolute(relativePath) ? relativePath : path.join(funcBaseDir, relativePath))
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

// support for different packaging strategies
function getFunctionBaseDir(directory, yaml, functionName) {
  // use case 1: serverless-webpack plugin
  if ((yaml.plugins || []).indexOf('serverless-webpack') > -1) {
    const oneLevelUp = yaml.package && yaml.package.individually === true ? functionName: 'service';
    directory = path.join(directory, oneLevelUp);
  }

  return directory;
}

function getRESTUrl(outputs) {
  return outputs.reduce((acc, curr) => {
    if (curr.OutputKey === 'ServiceEndpoint') {
      return curr.OutputValue
    }
    return acc
  }, '')
}

function getHTTPUrl(outputs) {
  return outputs.reduce((acc, curr) => {
    if (curr.OutputKey === 'HttpApiUrl') {
      return curr.OutputValue
    }
    return acc
  }, '')
}

function getFunctionRuntime(functionData, yaml) {
  return functionData.runtime || yaml.provider.runtime
}

function getFunctionRuntimeExtension(runtime) {
  let extension = '.js'
  if (runtime.match(/nodejs/)) {
    extension = '.js'
  } else if (runtime.match(/python/)) {
    extension = '.py'
  } else if (runtime.match(/go/)) {
    extension = '.go'
  }
  return extension
}

// ZazLambdaFunctionQualifiedArn
function getFunctionData(functionName, outputs) {
  const liveFunctionData = outputs.filter((out) => {
    return `${jsUcfirst(functionName)}` === out.OutputKey.replace('LambdaFunctionQualifiedArn', '')
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

function getFunctionNameFromArn(arn) {
  return arn.split(':')[6]
}

function jsUcfirst(string) {
  return string.charAt(0).toUpperCase() + string.slice(1)
}

function fsExistsSync(myDir) {
  try {
    fs.accessSync(myDir)
    return true
  } catch (e) {
    return false
  }
}

module.exports = ServerlessManifestPlugin
