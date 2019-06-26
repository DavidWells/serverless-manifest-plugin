const fs = require('fs')
const os = require('os')
const path = require('path')
const util = require('util')
const { getDependencies, getShallowDeps } = require('./getDeps')

class ServerlessManifestPlugin {
  constructor(serverless, options) {
    this.serverless = serverless
    this.options = options;
    this.commands = {
      manifest: {
        usage: 'Generate a service manifest file',
        lifecycleEvents: [
          'create'
        ],
        options: {
          json: {
            usage: 'Output json only for programatic usage',
          },
          silent: {
            usage: 'Stop console output after manifest created',
          },
          noSave: {
            usage: 'Disable manifest.json from being created',
          },
        },
      },
    }
    this.hooks = {
      // expose manifest command
      'manifest:create': this.afterDeploy.bind(this),
      // create after function deploy
      // 'after:deploy:function:deploy': this.afterDeploy.bind(this),
      // create after deploy
      'after:deploy:finalize': this.afterDeploy.bind(this),
      // Add special output here
      'after:info:info': this.runInfo.bind(this),
    }
  }
  runInfo() {
    // console.log('woowowowoow')
  }
  getData() {
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
          var manifestData = getFormattedData(this.serverless.service, stack)
          var stageData = {}
          stageData[stage] = manifestData
          resolve(stageData)
        })
    })
  }
  async afterDeploy() {
    // console.log('this runs after deploy')
    // console.log('this runs after deploy')
    const stageData = await this.getData()

    // console.log('stageData', stageData)
    const cwd = process.cwd()
    // console.log('stageData', stageData)
    const dotServerlessFolder = path.join(cwd, '.serverless')
    const manifestPath = path.join(dotServerlessFolder, 'manifest.json')
    const currentManifest = getManifestData(manifestPath)
    // merge together values. TODO deep merge
    const manifestData = Object.assign({}, currentManifest, stageData)
    // console.log('manifestData', manifestData)
    // write to config file
    if (this.options.json) {
      console.log(JSON.stringify(manifestData, null, 2))
    }
    if (this.options.noSave) {
      return false
    }
    saveManifest(manifestData, () => {
      if (this.options.silent || this.options.json) {
        return false
      }
      console.log(`Serverless manifest saved to\n${manifestPath}`)
    })
  }
  // https://github.com/dittto/serverless-shared-vars/blob/master/index.js#L15-L21
}

function saveManifest(manifestData, callback) {
  const cwd = process.cwd()
  const dotServerlessFolder = path.join(cwd, '.serverless')

  const manifestPath = path.join(dotServerlessFolder, 'manifest.json')
  if (!fsExistsSync(dotServerlessFolder)) {
    fs.mkdirSync(dotServerlessFolder)
  }
  const data = JSON.stringify(manifestData, null, 2)
  fs.writeFileSync(manifestPath, data)
  if (callback) {
    callback()
  }
}

function getManifestData(filePath) {
  if (fsExistsSync(filePath)) {
    const configValues = fs.readFileSync(filePath, 'utf8')
    if (configValues) {
      return JSON.parse(configValues)
    }
    // else return empty object
    return {}
  }
}

function getFormattedData(yaml = {}, stackOutput) {
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
      if (domainInfo) {
        const customBasePath = domainInfo.basePath || ''
        obj.urls['base'] = `https://${domainInfo.domainName}/${customBasePath}`
      } else {
        obj.urls['base'] = getApiBaseUrl(stackOutput.Outputs)
      }

      // Set base url
      if (!obj.urls['baseRaw']) {
        obj.urls['baseRaw'] = getApiBaseUrl(stackOutput.Outputs)
      }

      // Set url byPath
      const dataByPath = functionData.events.reduce((acc, event) => {
        if (event.http) {
          const value = acc[`${event.http.path}`]
          let method = [event.http.method]
          if (value && value.method.length) {
            // combine methods
            method = method.concat(value.method)
          }
          acc[`${event.http.path}`] = {
            url: `${obj.urls['base']}/${event.http.path}`,
            method: method
          }
        }
        return acc
      }, {})

      obj.urls['byPath'] = Object.assign({}, obj.urls['byPath'], dataByPath)

      // Set url functionName
      const dataByFunction = functionData.events.reduce((acc, event) => {
        if (event.http) {
          const value = acc[`${functionName}`]
          let method = [event.http.method]
          if (value && value.method.length) {
            // combine methods
            method = method.concat(value.method)
          }
          acc[`${functionName}`] = {
            url: `${obj.urls['base']}/${event.http.path}`,
            method: method
          }
        }
        return acc
      }, {})

      obj.urls['byFunction'] = Object.assign({}, obj.urls['byFunction'], dataByFunction)

      const dataByMethod = functionData.events.reduce((acc, event) => {
        if (event.http) {
          const value = obj.urls['byMethod'][`${event.http.method}`]
          const url = `${obj.urls['base']}/${event.http.path}`
          let urls = [url]
          if (value && value.length) {
            urls = value.concat(url)
          }
          acc[`${event.http.method}`] = urls
        }
        return acc
      }, {})

      obj.urls['byMethod'] = Object.assign({}, obj.urls['byMethod'], dataByMethod)

      // console.log('yaml.functions', yaml.functions[functionName])

      /* If runtime is node we can parse and list dependancies */
      // console.log('functionRuntime', functionRuntime)

      if (functionRuntime.match(/nodejs/)) {

        const functionPath = getFunctionPath(functionData, yaml)
        const functionContent = fs.readFileSync(functionPath, 'utf8')

        const directDeps = getShallowDeps(functionContent)

        const deps = getDependencies(functionPath, process.cwd())

        // Collect all node modules uses
        const modules = deps.map((dir) => {
          return dir.replace(process.cwd(), '')
        }).filter((d) => {
          return d.match((/\/node_modules/))
        }).map((dir) => {
          return path.dirname(dir).replace(/^\/node_modules\//, '').split('/')[0]
        })

        const nestedModules = Array.from(new Set(modules)).filter((el) => {
          // Remove direct dependencies (which should be listed in package.json)
          return directDeps.indexOf(el) < 0;
        })

        // console.log('nestedModules', nestedModules)
        // console.log('directDeps', directDeps)
        functionDependancies = {
          direct: directDeps,
          nested: nestedModules
        }
      }
    }

    const finalFunctionData = {
      [`${functionName}`]: {
        name: getFunctionNameFromArn(liveFunctionData.OutputValue),
        arn: liveFunctionData.OutputValue,
        runtime: functionRuntime,
        triggers: functionEvents.map((evt) => {
          return Object.keys(evt)
        }),
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
      base: '',
      baseRaw: '',
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

function hasCustomDomain(yaml = {}) {
  const { plugins, custom } = yaml
  if (hasPlugin(plugins, 'serverless-domain-manager') && custom && custom.customDomain && custom.customDomain.domainName) {
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

function getFunctionPath(functionData, yaml, directory) {
  const dir = directory || process.cwd()
  if (!functionData.handler) {
    throw new Error('handler missing from function')
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
    throw new Error('File not found')
  }
  return fullFilePath
}

function getApiBaseUrl(outputs) {
  return outputs.reduce((acc, curr) => {
    if (curr.OutputKey === 'ServiceEndpoint') {
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
    OutputKey: 'IdentifyLambdaFunctionQualifiedArn',
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
