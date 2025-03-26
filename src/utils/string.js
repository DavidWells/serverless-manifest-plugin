function getRegionFromArn(arn) {
  // ARN format: arn:partition:service:region:account-id:resource-type/resource-id
  const parts = arn.split(':')

  if (parts.length >= 4) {
    return parts[3]
  }

  return null
}

function getFunctionNameFromArn(arn) {
  // Check if the ARN is a valid Lambda ARN
  if (!arn || typeof arn !== 'string' || !arn.startsWith('arn:aws:lambda:')) {
    throw new Error('Invalid Lambda ARN format')
  }
  
  // Split the ARN by colon and get the last part (function name)
  const parts = arn.split(':')
  
  return parts[6]
}


function upperCaseFirst(string) {
  return string.charAt(0).toUpperCase() + string.slice(1)
}

function upperCase(str) {
  return str.toUpperCase()
}

module.exports = { 
  upperCase, 
  upperCaseFirst,
  getRegionFromArn, 
  getFunctionNameFromArn,
}
