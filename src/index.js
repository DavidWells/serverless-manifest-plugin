const fs = require('fs')
const os = require('os')
const path = require('path')
const { promisify } = require('util')
const { ensureGitIgnore } = require('./utils/gitignore')
const { getDependencies, getShallowDeps } = require('./utils/getDeps')
const { getCloudFormationConsoleUrl } = require('./utils/cloudformation/get-cloudformation-console-url')
const { fsExistsSync } = require('./utils/fs')
const { getResourceInfo } = require('./utils/get-resource-info')
const { getFunctionUrlConfig, removeDuplicates } = require('./utils/get-function-url')
const { getRegionFromArn, getFunctionNameFromArn, upperCase, upperCaseFirst } = require('./utils/string')
const { getAPIGatewayHttpUrl, getAPIGatewayHttpDetailsByLogicalId } = require('./utils/cloudformation/get-apigateway-http')
const { getAPIGatewayRestUrl, getAPIGatewayRestDetailsByLogicalId } = require('./utils/cloudformation/get-apigateway-rest')
const { getRestApiDomainNames } = require('./utils/apigateway-rest/get-domain-names')
const { combineMatchingItems } = require('./utils/array')
const { deepLog } = require('./utils/log')
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)

class ServerlessManifestPlugin {
  constructor(serverless, options) {
    this.serverless = serverless
    this.options = options
    this.provider = this.serverless.getProvider('aws')
    this.service = this.serverless.service
    this.stage = this.options.stage || this.service.provider.stage || 'dev'
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
            usage: 'Output path for serverless manifest file. Default /.serverless/manifests/manifest.[stage].json',
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

    // Use manifests directory
    this.manifestFileName = `manifest.${this.stage}.json`
    this.manifestsDir = 'manifests'

    this.hooks = {
      /* expose `sls manifest` command */
      'manifest:create': this.generateManifest.bind(this),
      'after:deploy:deploy': this.afterDeploy.bind(this),
      'before:remove:remove': this.beforeRemove.bind(this),
      'manifest:generate': this.generate.bind(this),
      'manifest:clean': this.clean.bind(this),
      /* TODO Add special output here */
      // 'after:info:info': this.runInfo.bind(this),
    }
    const { disablePostDeployGeneration } = getCustomSettings(this.serverless)
    if (!disablePostDeployGeneration) {
      /* create manifest after deploy */
      this.hooks['after:deploy:finalize'] = this.generateManifest.bind(this)
      // 'aws:common:cleanupTempDir': () => {
      //   serverless.cli.log('disabled aws:common:cleanupTempDir')
      //   return Promise.resolve()
      // },
      // 'aws:common:cleanupTempDir:cleanup': () => {
      //   serverless.cli.log('disabled aws:common:cleanupTempDir:cleanup')
      //   return Promise.resolve()
      // },
      // 'aws:deploy:finalize:cleanup': () => {
      //   serverless.cli.log('disabled aws:deploy:finalize:cleanup')
      //   return Promise.resolve()
      // }
      /* create manifest after single function deploy */
      // this.hooks['after:deploy:function:deploy'] = this.generateManifest.bind(this)
    }

    // Store original spawn function
    const originalSpawn = this.serverless.pluginManager.spawn
    // Override spawn to intercept cleanupTempDir calls
    this.serverless.pluginManager.spawn = function(hookName) {
      if (hookName === 'aws:common:cleanupTempDir') {
        serverless.cli.log('Manifest plugin disabled aws:common:cleanupTempDir')
        return Promise.resolve()
      }
      // Call original spawn for other hooks
      return originalSpawn.apply(this, arguments)
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
  getData(srcPath, cfTemplateData) {
    var name = this.serverless.service.getServiceName()
    var provider = this.serverless.getProvider('aws')
    var stage = provider.getStage()
    var region = provider.getRegion()
    var stackName = provider.naming.getStackName()
    var params = { StackName: `${stackName}` }

    // Extract account ID from provider info if available
    var accountId = ''
    
    return (async () => {
      // Try to get account ID if available through the provider
      if (provider.getAccountId) {
        try {
          // Handle case when getAccountId returns a Promise
          const accountIdResult = provider.getAccountId()
          if (accountIdResult && typeof accountIdResult.then === 'function') {
            try {
              accountId = await accountIdResult
            } catch (e) {
              if (e.message.includes('security token') && e.message.includes('expired')) {
                throw e
              }
              accountId = ''
            }
          } else {
            accountId = accountIdResult
          }
          
          // Ensure accountId is a string
          if (accountId && typeof accountId !== 'string') {
            accountId = String(accountId)
          }
        } catch (e) {
          this.serverless.cli.log(`Error: Could not retrieve AWS account ID.`)
          this.serverless.cli.log(`${e.message}`)
          if (e.message.includes('security token') && e.message.includes('expired')) {
            throw new Error('AWS security token expired. Please re-authenticate.')
          }
        }
      }
      
      // If accountId is empty or an object, reset it
      if (!accountId || typeof accountId === 'object') {
        accountId = ''
      }
      
      try {
        const data = await provider.request('CloudFormation', 'describeStacks', params, stage, region)
        var stack = data.Stacks.pop() || { Outputs: [] }
        
        // Extract accountId from stack ARN if not already available
        if ((!accountId || accountId === '') && stack.StackId) {
          const arnParts = stack.StackId.split(':')
          if (arnParts.length >= 5) {
            accountId = arnParts[4]
          }
        }
        
        // Ensure accountId is a string and not an object
        if (accountId && typeof accountId !== 'string') {
          accountId = String(accountId)
        }
        
        // If accountId is an object or empty, set it to empty string
        if (!accountId || typeof accountId === 'object') {
          accountId = ''
        }
        
        // Pass the full stack ID to getFormattedData
        const manifestData = await getFormattedData(
          this.serverless.service, 
          stack, 
          srcPath, 
          cfTemplateData, 
          region, 
          accountId, 
          stack.StackId
        )
        
        // We'll still return a stage-keyed object for internal use
        // but we'll extract it in generateManifest before writing to file
        var stageData = {}
        stageData[stage] = manifestData
        return stageData
      } catch (err) {
        console.log('err', err)
        this.serverless.cli.log(`Error fetching CloudFormation data: ${err.message}`)
        // Return empty data on error to allow continued operation
        var stageData = {}
        stageData[stage] = {
          metadata: {
            lastUpdated: new Date().toISOString(),
            stack: {
              name: stackName || '',
              stackId: stack.StackId || '',
              status: '',
              description: '',
              creationTime: '',
              lastUpdatedTime: '',
              tags: [],
              terminationProtection: false,
              consoleUrl: getCloudFormationConsoleUrl(region, stack.StackId)
            }
          },
          region: region,
          accountId: '', // Always set accountId as empty string on error
          urls: {},
          functions: {},
          outputs: [],
          endpoints: {}
        }
        return stageData
      }
    })()
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
    Allows for customizing where the manifest looks for function code
    */
    const srcPath = customOpts.srcPath || this.options.srcPath || process.cwd()

    if (!silenceLogs) {
      console.log(`● Creating Serverless manifest for stage "${this.stage}"...\n`)
    }

    if (disableFileOutput && !handlePostProcessing) {
      console.log('No manifest data processed or saved. "disableOutput" is true & no "postProcess" option is set')
      console.log(' Make sure you create a function to handle your manifest data')
      console.log(' Example:')
      console.log('  postProcess: ./my-file-to-process.js')
      return false
    }

    let cfTemplateData = {}
    try {
      const cfTemplate = fs.readFileSync(
        path.join(srcPath, '.serverless/cloudformation-template-update-stack.json'), 
        'utf8'
      )
      cfTemplateData = JSON.parse(cfTemplate)
    } catch (err) {
      
    }

    /* Fetch live service data */
    const stageData = await this.getData(srcPath, cfTemplateData)
    
    // Extract the current stage data directly without the stage wrapper
    const currentStageData = stageData[this.stage] || {}

    const cwd = srcPath
    const dotServerlessFolder = path.join(cwd, '.serverless')
    const manifestsFolder = path.join(dotServerlessFolder, this.manifestsDir)
    
    // Ensure manifests directory exists
    if (!fs.existsSync(manifestsFolder)) {
      fs.mkdirSync(manifestsFolder, { recursive: true })
    }
    
    // Use the stage-specific manifest file path
    let manifestPath = path.join(manifestsFolder, this.manifestFileName)
    if (customOutputPath) {
      // If custom output path provided, add stage to filename to maintain separation
      const customPathInfo = path.parse(customOutputPath)
      const newFileName = `${customPathInfo.name}.${this.stage}${customPathInfo.ext}`
      manifestPath = path.join(customPathInfo.dir, newFileName)
    }
    // console.log('manifestPath', manifestPath)

    const currentManifest = getManifestData(manifestPath)
    // TODOFor diffing? 


    // console.log('currentManifest', currentManifest)
    
    // Use the direct data without stage wrapping
    const manifestData = currentStageData
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
          console.log(`● Saving Serverless manifest file for stage "${this.stage}"...\n`)
        }
        // Write to the standard location
        await saveManifest(manifestData, manifestPath)
        
        // If we have an account ID, also write to the nested folder structure
        if (manifestData.accountId) {
          const accountId = manifestData.accountId
          const region = manifestData.region || this.serverless.getProvider('aws').getRegion()
          
          // Create the nested directory structure
          const accountFolder = path.join(manifestsFolder, accountId)
          const regionFolder = path.join(accountFolder, region)
          
          // Create directories if they don't exist
          if (!fs.existsSync(accountFolder)) {
            fs.mkdirSync(accountFolder, { recursive: true })
          }
          
          if (!fs.existsSync(regionFolder)) {
            fs.mkdirSync(regionFolder, { recursive: true })
          }
          
          // Write the same data to the nested location
          const nestedManifestPath = path.join(regionFolder, this.manifestFileName)
          await saveManifest(manifestData, nestedManifestPath)
          
          if (!silenceLogs) {
            console.log(` Also saved to: ${nestedManifestPath.replace(cwd, '')}`)
          }
        }
        
        if (!silenceLogs) {
          console.log(`✓ Save manifest complete`)
          console.log(`  Output path:  ${manifestPath.replace(cwd, '')}`)
          console.log(`  Full path:    ${manifestPath}`)
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

    await this.updateMainManifestIndex(silenceLogs)

    return manifestData
  }

  async afterDeploy() {
    this.serverless.cli.log('Generating manifest...')
    
    const manifestData = await this.generateManifest()
    
    // Update the main manifest index after writing the stage-specific manifest
    await this.updateMainManifestIndex()
    
    return this.writeManifest(manifestData)
  }

  async generate() {
    this.serverless.cli.log(`Generating manifest for stage "${this.stage}"...`)
    
    const manifestData = await this.generateManifest()
    
    return this.writeManifest(manifestData)
  }

  async updateMainManifestIndex(silenceLogs) {
    const manifestPath = path.join(this.serverless.config.servicePath, '.serverless')
    const manifestsFolder = path.join(manifestPath, this.manifestsDir)
    const mainManifestPath = path.join(manifestPath, 'manifest.json')
    
    try {
      // Create the directories if they don't exist
      if (!fs.existsSync(manifestPath)) {
        fs.mkdirSync(manifestPath, { recursive: true })
      }
      
      if (!fs.existsSync(manifestsFolder)) {
        fs.mkdirSync(manifestsFolder, { recursive: true })
      }
      
      // Read the current main manifest if it exists
      let mainManifest = { byStage: {}, byRegion: {}, byAccount: {}, files: [] }
      if (fs.existsSync(mainManifestPath)) {
        try {
          const mainManifestContent = fs.readFileSync(mainManifestPath, 'utf8')
          mainManifest = JSON.parse(mainManifestContent)
          
          // Make sure required sections exist
          if (!mainManifest.files) {
            mainManifest.files = []
          }
          
          // Initialize required nested objects if they don't exist
          if (!mainManifest.byStage) {
            mainManifest.byStage = {}
          }
          
          if (!mainManifest.byRegion) {
            mainManifest.byRegion = {}
          }
          
          if (!mainManifest.byAccount) {
            mainManifest.byAccount = {}
          }
        } catch (error) {
          this.serverless.cli.log(`Error reading main manifest, creating a new one: ${error.message}`)
        }
      }
      
      // Get the current region and try to get the accountId
      const region = this.serverless.getProvider('aws').getRegion()
      
      // Try to get the account ID from the manifest file we just created
      let accountId = ''
      let stackId = '';
      const manifestFilePath = path.join(manifestsFolder, this.manifestFileName)
      
      if (fs.existsSync(manifestFilePath)) {
        try {
          const manifestContent = fs.readFileSync(manifestFilePath, 'utf8')
          const manifestData = JSON.parse(manifestContent)
          
          // Try multiple possible locations for account ID
          if (manifestData && manifestData.accountId) {
            accountId = manifestData.accountId
          } else if (manifestData && manifestData.metadata && manifestData.metadata.accountId) {
            accountId = manifestData.metadata.accountId
          } else if (manifestData && manifestData.metadata && manifestData.metadata.stack && 
                    manifestData.metadata.stack.id) {
            // Try to extract account ID from stack ID
            const stackIdValue = manifestData.metadata.stack.id;
            if (stackIdValue) {
              const arnParts = stackIdValue.split(':');
              if (arnParts.length >= 5) {
                accountId = arnParts[4];
              }
            }
          }
          
          // Also extract stackId if available
          if (manifestData && manifestData.metadata && manifestData.metadata.stack) {
            stackId = manifestData.metadata.stack.id || '';
          }
        } catch (error) {
          this.serverless.cli.log(`Error reading manifest file to get account ID: ${error.message}`)
        }
      }
      
      // Try to get account ID directly from provider if still not found
      if (!accountId) {
        try {
          if (this.provider.getAccountId) {
            const providerAccountId = await this.provider.getAccountId();
            if (providerAccountId && typeof providerAccountId === 'string') {
              accountId = providerAccountId;
            }
          }
        } catch (error) {
          this.serverless.cli.log(`Error getting account ID from provider: ${error.message}`)
        }
      }
      
      // If account ID is in the byAccount section but not found above, use that
      if (!accountId && Object.keys(mainManifest.byAccount).length > 0) {
        // Just use the first account ID in the byAccount section
        accountId = Object.keys(mainManifest.byAccount)[0];
      }
      
      let stackName = '';
      let stackDescription = '';
      let stackLastUpdatedTime = '';
      let stackConsoleUrl = '';
      
      // Try to get stack information from the manifest file
      if (fs.existsSync(manifestFilePath)) {
        try {
          const manifestContent = fs.readFileSync(manifestFilePath, 'utf8');
          const manifestData = JSON.parse(manifestContent);
          
          if (manifestData && manifestData.metadata && manifestData.metadata.stack) {
            stackName = manifestData.metadata.stack.name || '';
            stackDescription = manifestData.metadata.stack.description || '';
            stackLastUpdatedTime = manifestData.metadata.stack.lastUpdatedTime || '';
            stackConsoleUrl = manifestData.metadata.stack.consoleUrl || '';
          }
        } catch (error) {
          this.serverless.cli.log(`Error reading manifest file to get stack information: ${error.message}`);
        }
      }
      
      // Standard path to the manifest file (relative path for the index)
      const relativeManifestPath = `/.serverless/${this.manifestsDir}/${this.manifestFileName}`
      
      // Nested manifest path for the account structure
      const nestedRelativePath = accountId 
        ? `/.serverless/${this.manifestsDir}/${accountId}/${region}/${this.manifestFileName}`
        : null
      
      // Metadata about this deployment for both byStage and byRegion
      const deploymentMetadata = {
        stackName: stackName,
        description: stackDescription,
        region: region,
        account: accountId || '',
        lastUpdatedTime: stackLastUpdatedTime,
        file: relativeManifestPath,
        consoleUrl: stackConsoleUrl,
      }
      
      // Add to byStage with enhanced metadata
      mainManifest.byStage[this.stage] = deploymentMetadata
      
      // Ensure byRegion structure exists for the current region
      if (!mainManifest.byRegion[region]) {
        mainManifest.byRegion[region] = {}
      }
      
      // Add to byRegion with enhanced metadata
      mainManifest.byRegion[region][this.stage] = deploymentMetadata
      
      // Organize by account ID if available
      if (accountId) {
        // Ensure byAccount structure exists
        if (!mainManifest.byAccount[accountId]) {
          mainManifest.byAccount[accountId] = {}
        }
        
        if (!mainManifest.byAccount[accountId][region]) {
          mainManifest.byAccount[accountId][region] = {}
        }
        
        // For byAccount, point to the nested path
        mainManifest.byAccount[accountId][region][this.stage] = nestedRelativePath
        
        // Add the nested path to the files array
        if (nestedRelativePath && !mainManifest.files.includes(nestedRelativePath)) {
          mainManifest.files.push(nestedRelativePath)
        }
      }
      
      // Update the files array if the standard path isn't already included
      if (!mainManifest.files.includes(relativeManifestPath)) {
        mainManifest.files.push(relativeManifestPath)
      }
      
      // Write back the updated manifest or remove it if it's now empty
      if (
        Object.keys(mainManifest.byStage).length > 0 || 
        Object.keys(mainManifest.byRegion).length > 0 ||
        Object.keys(mainManifest.byAccount || {}).length > 0 ||
        (mainManifest.files && mainManifest.files.length > 0)
      ) {
        // Create an ordered manifest with metadata updated
        const orderedManifest = {
          metadata: mainManifest.metadata || {
            manifestUpdated: new Date().toISOString()
          },
          byStage: mainManifest.byStage || {},
          byRegion: mainManifest.byRegion || {},
          byAccount: mainManifest.byAccount || {},
          files: mainManifest.files || []
        }
        
        // Update the lastUpdated timestamp
        orderedManifest.metadata.manifestUpdated = new Date().toISOString();
        
        fs.writeFileSync(mainManifestPath, JSON.stringify(orderedManifest, null, 2))
        this.serverless.cli.log(`  Index path:   ${mainManifestPath}`)
        
        // Generate and log the AWS CloudFormation console URL
        if (stackId && region) {
          const consoleUrl = getCloudFormationConsoleUrl(region, stackId);
          if (consoleUrl) {
            this.serverless.cli.log();
            this.serverless.cli.log(`AWS CloudFormation console url:`);
            this.serverless.cli.log(consoleUrl);
          }
        } else if (stackConsoleUrl) {
          this.serverless.cli.log();
          this.serverless.cli.log(`AWS CloudFormation console url:`);
          this.serverless.cli.log(stackConsoleUrl);
        }
      } else {
        fs.unlinkSync(mainManifestPath)
        this.serverless.cli.log(`Main manifest index removed: ${mainManifestPath}`)
      }
    } catch (error) {
      this.serverless.cli.log(`Error updating main manifest index: ${error.message}`)
      throw error
    }
  }

  async writeManifest(manifestData) {
    const manifestPath = path.join(this.serverless.config.servicePath, '.serverless')
    const manifestsFolder = path.join(manifestPath, this.manifestsDir)
    const manifestFilePath = path.join(manifestsFolder, this.manifestFileName)
    
    try {
      // Ensure both directories exist
      if (!fs.existsSync(manifestPath)) {
        fs.mkdirSync(manifestPath, { recursive: true })
      }
      
      if (!fs.existsSync(manifestsFolder)) {
        fs.mkdirSync(manifestsFolder, { recursive: true })
      }
      
      // Write the manifest data to the standard location
      fs.writeFileSync(manifestFilePath, JSON.stringify(manifestData, null, 2))
      this.serverless.cli.log(`Manifest file saved to: ${manifestFilePath}`)
      
      // If we have an account ID, also write to the nested folder structure
      if (manifestData.accountId) {
        const accountId = manifestData.accountId
        const region = manifestData.region || this.serverless.getProvider('aws').getRegion()
        
        // Create the nested directory structure
        const accountFolder = path.join(manifestsFolder, accountId)
        const regionFolder = path.join(accountFolder, region)
        
        // Create directories if they don't exist
        if (!fs.existsSync(accountFolder)) {
          fs.mkdirSync(accountFolder, { recursive: true })
        }
        
        if (!fs.existsSync(regionFolder)) {
          fs.mkdirSync(regionFolder, { recursive: true })
        }
        
        // Write the same data to the nested location
        const nestedManifestPath = path.join(regionFolder, this.manifestFileName)
        fs.writeFileSync(nestedManifestPath, JSON.stringify(manifestData, null, 2))
        this.serverless.cli.log(`Manifest file also saved to: ${nestedManifestPath}`)
        
        // Return the standard path as the result
        return manifestFilePath
      }
      
      return manifestFilePath
    } catch (error) {
      this.serverless.cli.log(`Error writing manifest file: ${error.message}`)
      throw error
    }
  }

  async clean() {
    const manifestPath = path.join(this.serverless.config.servicePath, '.serverless')
    const manifestsFolder = path.join(manifestPath, this.manifestsDir)
    const manifestFilePath = path.join(manifestsFolder, this.manifestFileName)
    const mainManifestPath = path.join(manifestPath, 'manifest.json')
    
    try {
      // Try to get the account ID from the manifest file before removing it
      let accountId = ''
      let region = this.serverless.getProvider('aws').getRegion()
      
      if (fs.existsSync(manifestFilePath)) {
        try {
          const manifestContent = fs.readFileSync(manifestFilePath, 'utf8')
          const manifestData = JSON.parse(manifestContent)
          if (manifestData && manifestData.accountId) {
            accountId = manifestData.accountId
          }
          if (manifestData && manifestData.region) {
            region = manifestData.region
          }
        } catch (error) {
          this.serverless.cli.log(`Error reading manifest file to get account ID: ${error.message}`)
        }
        
        // Remove the standard manifest file
        fs.unlinkSync(manifestFilePath)
        this.serverless.cli.log(`Manifest file removed: ${manifestFilePath}`)
        
        // Remove the nested manifest file if it exists
        if (accountId) {
          const nestedManifestPath = path.join(manifestsFolder, accountId, region, this.manifestFileName)
          if (fs.existsSync(nestedManifestPath)) {
            fs.unlinkSync(nestedManifestPath)
            this.serverless.cli.log(`Nested manifest file removed: ${nestedManifestPath}`)
            
            // Try to clean up empty directories
            const regionDir = path.dirname(nestedManifestPath)
            const accountDir = path.dirname(regionDir)
            
            // Remove region directory if empty
            try {
              if (fs.readdirSync(regionDir).length === 0) {
                fs.rmdirSync(regionDir)
                this.serverless.cli.log(`Removed empty region directory: ${regionDir}`)
                
                // Remove account directory if empty
                if (fs.readdirSync(accountDir).length === 0) {
                  fs.rmdirSync(accountDir)
                  this.serverless.cli.log(`Removed empty account directory: ${accountDir}`)
                }
              }
            } catch (err) {
              this.serverless.cli.log(`Error cleaning up empty directories: ${err.message}`)
            }
          }
        }
      } else {
        this.serverless.cli.log(`Manifest file not found: ${manifestFilePath}`)
      }
      
      // Update the main manifest to remove this stage
      if (fs.existsSync(mainManifestPath)) {
        try {
          const mainManifestContent = fs.readFileSync(mainManifestPath, 'utf8')
          const mainManifest = JSON.parse(mainManifestContent)
          
          // The relative paths to remove from all sections
          const relativeManifestPath = `/.serverless/${this.manifestsDir}/${this.manifestFileName}`
          const nestedRelativePath = accountId 
            ? `/.serverless/${this.manifestsDir}/${accountId}/${region}/${this.manifestFileName}`
            : null
          
          // Remove the stage from byStage (now contains enhanced metadata)
          if (mainManifest.byStage && mainManifest.byStage[this.stage]) {
            delete mainManifest.byStage[this.stage]
          }
          
          // Remove the stage from byRegion (now contains enhanced metadata)
          if (mainManifest.byRegion && mainManifest.byRegion[region] && mainManifest.byRegion[region][this.stage]) {
            delete mainManifest.byRegion[region][this.stage]
            
            // Remove the region if it's now empty
            if (Object.keys(mainManifest.byRegion[region]).length === 0) {
              delete mainManifest.byRegion[region]
            }
          }
          
          // Remove the stage from byAccount if accountId is available
          if (accountId && mainManifest.byAccount && mainManifest.byAccount[accountId]) {
            if (mainManifest.byAccount[accountId][region] && mainManifest.byAccount[accountId][region][this.stage]) {
              delete mainManifest.byAccount[accountId][region][this.stage]
              
              // Remove the region if it's now empty
              if (Object.keys(mainManifest.byAccount[accountId][region]).length === 0) {
                delete mainManifest.byAccount[accountId][region]
              }
              
              // Remove the account if it's now empty
              if (Object.keys(mainManifest.byAccount[accountId]).length === 0) {
                delete mainManifest.byAccount[accountId]
              }
            }
          }
          
          // Remove both paths from the files array
          if (mainManifest.files) {
            mainManifest.files = mainManifest.files.filter(file => 
              file !== relativeManifestPath && (!nestedRelativePath || file !== nestedRelativePath)
            )
          }
          
          // Write back the updated manifest or remove it if it's now empty
          if (
            Object.keys(mainManifest.byStage).length > 0 || 
            Object.keys(mainManifest.byRegion).length > 0 ||
            Object.keys(mainManifest.byAccount || {}).length > 0 ||
            (mainManifest.files && mainManifest.files.length > 0)
          ) {
            // Create an ordered manifest with metadata updated
            const orderedManifest = {
              metadata: mainManifest.metadata || {
                manifestUpdated: new Date().toISOString()
              },
              byStage: mainManifest.byStage || {},
              byRegion: mainManifest.byRegion || {},
              byAccount: mainManifest.byAccount || {},
              files: mainManifest.files || []
            }
            
            // Update the lastUpdated timestamp
            orderedManifest.metadata.manifestUpdated = new Date().toISOString();
            
            fs.writeFileSync(mainManifestPath, JSON.stringify(orderedManifest, null, 2))
            this.serverless.cli.log(`Main manifest index updated at: ${mainManifestPath}`)
          } else {
            fs.unlinkSync(mainManifestPath)
            this.serverless.cli.log(`Main manifest index removed: ${mainManifestPath}`)
          }
        } catch (error) {
          this.serverless.cli.log(`Error updating main manifest index: ${error.message}`)
        }
      }
    } catch (error) {
      this.serverless.cli.log(`Error removing manifest file: ${error.message}`)
      throw error
    }
  }

  async beforeRemove() {
    return this.clean()
  }

  async readManifest() {
    const manifestPath = path.join(this.serverless.config.servicePath, '.serverless')
    const manifestsFolder = path.join(manifestPath, this.manifestsDir)
    const manifestFilePath = path.join(manifestsFolder, this.manifestFileName)
    
    try {
      if (fs.existsSync(manifestFilePath)) {
        const manifestContent = fs.readFileSync(manifestFilePath, 'utf8')
        return JSON.parse(manifestContent)
      }
    } catch (error) {
      this.serverless.cli.log(`Error reading manifest file: ${error.message}`)
    }
    
    return null
  }
}

async function saveManifest(manifestData, manifestPath) {
  const cwd = process.cwd()
  const parentDir = path.dirname(manifestPath)
  
  // Ensure the parent directory exists - use recursive to create the full path
  if (!fsExistsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true })
  }
  
  // Write the manifest data directly without stage wrapping
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
    console.log('resourceName', resourceName, resource.Type)
    if (resource.Type === 'AWS::ApiGateway::Resource') {
      const restApiId = resolveRestApiId((resource.Properties || {}))
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
function getAllLambdaFunctionUrls(yaml, compiledCf, stackOutput) {
  const outputs = stackOutput.Outputs || []
  const stackName = stackOutput.StackName || ''

  /* Check serverless.yml for functions with url property */
  let fnsWithUrls = []
  if (yaml.functions) {
    const fns = Object.keys(yaml.functions)
    // console.log('fns', fns)
    fnsWithUrls = fns.filter((fn) => {
      const fnData = yaml.functions[fn]
      // console.log('fnData', fnData)
      return fnData && fnData.hasOwnProperty('url')
    }).map((fn) => {
      if (yaml.functions[fn] && yaml.functions[fn].hasOwnProperty('name')) {
        return {
          fnName: yaml.functions[fn].name,
          fnConfig: yaml.functions[fn],
          via: 'serverless.yml function config'
        }
      }
      return yaml.functions[fn]
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
      if (yaml.functions && yaml.functions[fnNameLower]) {
        resolvedFnName = stackOutput.StackName + '-' + fnNameLower
      } else if (yaml.functions && yaml.functions[aproxFnName]) {
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
        logicialId: resource,
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
    if (fn.fnUrlResource && fn.fnUrlResource.Properties && fn.fnUrlResource.Properties.Cors &&  fn.fnUrlResource.Properties.Cors.AllowMethods) {
      fn.methods = fn.fnUrlResource.Properties.Cors.AllowMethods.map((method) => {
        return { httpMethod: method }
      })
    }
    return fn
  })

  // process.exit(0)

  // const resourceInfo = await getResourceInfo("tester-xyz-user-service-prod", "CustomResourceDelayFunction", "us-east-1")
  // console.log('resourceInfo', resourceInfo)

  return formatted
}

async function getFormattedData(yaml = {}, stackOutput, srcDir, cfTemplateData, region, accountId) {
  let resources = {}
  if (yaml.resources && yaml.resources.Resources) {
    resources = yaml.resources.Resources
  }

  let outputs = {}
  if (yaml.resources && yaml.resources.Outputs) {
    outputs = yaml.resources.Outputs
  }

  console.log('stackOutput', stackOutput)

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

  deepLog('foundLambdaFnUrls', foundLambdaFnUrls)

  let functionUrls = []
  if (foundLambdaFnUrls && foundLambdaFnUrls.length) {
    const functionUrlsPromises = foundLambdaFnUrls.map((fn) => {
      const name = (fn && fn.Properties && fn.Properties.FunctionName) ? fn.Properties.FunctionName : fn.fnName
      if (fn.url) {
        return fn
      }
      console.log('name', name)
      return getFunctionUrlConfig(name, getRegionFromArn(stackOutput.StackId))
    })

    functionUrls = (await Promise.all(functionUrlsPromises)).filter(Boolean)
    deepLog('resolved functionUrls', functionUrls)
  }

  if (functionUrls && functionUrls.length) {
    functionUrls.forEach((fnUrlInfo) => {
      const functionName = fnUrlInfo.fnName
      const functionUrl = fnUrlInfo.url
      const methods = fnUrlInfo.methods || []
      deepLog('fnUrlInfo', fnUrlInfo)

      const set =  {
        api: fnUrlInfo.fnResource.logicalId,
        url: functionUrl,
        type: 'functionUrl',
        methods: methods,
        Properties: fnUrlInfo.fnUrlResource.Properties,
        resourceName: fnUrlInfo.fnUrlResource.logicalId
      }

      if (fnUrlInfo.fnUrlResource && fnUrlInfo.fnUrlResource.logicalId) {
        apiEndpoints[fnUrlInfo.fnUrlResource.logicalId] = set
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
  deepLog('remoteAPIData', remoteAPIData)
  const allUrls = remoteAPIData.map((data) => {
    return data.url
  })
  deepLog('allUrls', allUrls)

  const apiMap = {}
  urlKeys.forEach((key, i) => {
    const endpoint = apiEndpoints[key]
    apiMap[endpoint.api] = {
      id: remoteAPIData[i].id,
      type: endpoint.type,
      baseUrl: allUrls[i],
      region: region,
      endpointCount: apiMap[endpoint.api] ? apiMap[endpoint.api].endpointCount + 1 : 1
      // hasAuth
    }
    apiEndpoints[key].url = allUrls[i] + (endpoint.path || '')
  })
  
  // deepLog('apiMap', apiMap)
  // process.exit(0)

  // process.exit(0)

  // return

  const manifestUrlBase = {}

  const apiMapKeys = Object.keys(apiMap)
  if (apiMapKeys && apiMapKeys.length) {
    /* resolve domains */
    const domainPromises = apiMapKeys.map((key) => {
      const api = apiMap[key]
      return getRestApiDomainNames(api.id, api.region)
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

  if (functionUrls && functionUrls.length) {
    // const x = functionUrls.reduce((acc, fnUrlInfo) => {
    //   // acc[fn.fnName] = fn
    //   // console.log('fnUrlInfo', fnUrlInfo)
    //   return acc
    // }, manifestData)
    // console.log('x', x)
  }

  return manifestData
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

function resolveFunction(resourceDetails, compiledCf) {
  if (typeof resourceDetails === 'string') {
    return resourceDetails
  }
  const functionProperties = resourceDetails.Properties || {}
  if (resourceDetails && functionProperties && functionProperties.TargetFunctionArn) {
    if (typeof functionProperties.TargetFunctionArn == 'string' && functionProperties.TargetFunctionArn.includes('arn:aws:lambda')) {
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

function getFunctionRuntime(functionData = {}, yaml = {}) {
  if (functionData.runtime) {
    return functionData.runtime
  }
  if (yaml.provider && yaml.provider.runtime) {
    return yaml.provider.runtime
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

module.exports = ServerlessManifestPlugin
