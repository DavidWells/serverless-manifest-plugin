const fs = require('fs')
const path = require('path')
const util = require('util')

class ServerlessManifestPlugin {
  constructor(serverless, options) {
    this.serverless = serverless
    this.commands = {
      manifest: {
        lifecycleEvents: [
          'create'
        ],
        usage: 'Generate a manifest file',
      },
    }
    this.hooks = {
      // expose manifest command
      'manifest:create': this.afterDeploy.bind(this),
      // create after deploy
      'after:deploy:finalize': this.afterDeploy.bind(this),
    }
  }
  getData() {
    var name = this.serverless.service.getServiceName()
    var provider = this.serverless.getProvider('aws')
    var stage = provider.getStage()
    var region = provider.getRegion()
    var params = { StackName: `${name}-${stage}` }

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
    saveManifest(manifestData, () => {
      console.log(`Serverless manifest saved to ${manifestPath}`)
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

function getFormattedData(yaml, stackOutput) {
  let resources = {}
  if (yaml && yaml.resources && yaml.resources.Resources) {
    resources = yaml.resources.Resources
    // console.log('resources', resources)
  }

  let outputs = {}
  if (yaml && yaml.resources && yaml.resources.Outputs) {
    outputs = yaml.resources.Outputs
  }

  const manifestData = Object.keys(yaml.functions).reduce((obj, functionName) => {
    const functionData = yaml.functions[functionName]
    if (functionData.events) {
      // Set base url
      if (!obj.urls['base']) {
        obj.urls['base'] = getApiBaseUrl(stackOutput.Outputs)
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

      /*
      "functions": {
        "auth": {
          "name": "site-form-service-prod-auth",
          "arn": "xyxyxyxyx"
        },
      */

      // functions and arns
      const funcObj = obj['functions'] || {}
      const fData = getFunctionData(functionName, stackOutput.Outputs)

      obj['functions'] = Object.assign({}, funcObj, {
        [`${functionName}`]: {
          name: getFunctionNameFromArn(fData.OutputValue),
          arn: fData.OutputValue
        }
      })
    }
    return obj
  }, {
    urls: {
      base: '',
      byPath: {},
      byFunction: {}
    },
    functions: {},
    outputs: stackOutput.Outputs
    // TODO remove sensitive data from resources
    // resources: resources
  })

  return manifestData
}

function getApiBaseUrl(outputs) {
  return outputs.reduce((acc, curr) => {
    if (curr.OutputKey === 'ServiceEndpoint') {
      return curr.OutputValue
    }
    return acc
  }, '')
}

// ZazLambdaFunctionQualifiedArn
function getFunctionData(functionName, outputs) {
  return outputs.filter((out) => {
    return `${jsUcfirst(functionName)}` === out.OutputKey.replace('LambdaFunctionQualifiedArn', '')
  })[0]
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
