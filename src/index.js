const fs = require('fs')
const path = require('path')
const { ensureGitIgnore } = require('./utils/gitignore')
const { getCloudFormationConsoleUrl } = require('./utils/cloudformation/get-cloudformation-console-url')
const { fsExistsSync } = require('./utils/fs')
const { getFormattedData } = require('./format')

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
        
        // console.log('manifestData', Object.keys(manifestData))
        // process.exit(0)
        // We'll still return a stage-keyed object for internal use
        // but we'll extract it in generateManifest before writing to file
        var stageData = {}
        stageData[stage] = manifestData
        return stageData
      } catch (err) {
        console.log('Get Data Error', err)
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
    // TODO For diffing? 

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
        if (manifestData.metadata && manifestData.metadata.accountId) {
          const accountId = manifestData.metadata.accountId
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

      if (!stackLastUpdatedTime) {
        // deploymentMetadata.deployed = false
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

module.exports = ServerlessManifestPlugin
