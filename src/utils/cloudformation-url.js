/**
 * Generates a properly formatted AWS CloudFormation console URL for a stack
 * 
 * @param {string} region - AWS region
 * @param {string} accountId - AWS account ID
 * @param {string} stackName - CloudFormation stack name
 * @param {string} fullStackId - Complete CloudFormation stack ID (required)
 * @returns {string} - Formatted AWS console URL
 */
function getCloudFormationConsoleUrl(region, fullStackId) {
  if (!region || !fullStackId) {
    return '';
  }
  
  // Create a CloudFormation console URL that matches the exact format:
  // https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/resources?filteringText=&filteringStatus=active&viewNested=true&stackId=arn%3Aaws%3Acloudformation%3Aus-east-1%3A919731871945%3Astack%2Ftest-service-for-manifest-plugin-prod%2F4feadf20-b42e-11eb-a49c-121bb4249a31
  
  // Base URL structure with the correct parameter order
  let baseUrl = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/resources?filteringText=&filteringStatus=active&viewNested=true`;
  
  // URL encode the full stack ID
  const encodedStackId = encodeURIComponent(fullStackId);
  baseUrl += `&stackId=${encodedStackId}`;
  
  return baseUrl;
}

module.exports = {
  getCloudFormationConsoleUrl
};