

function getRegionFromStackId(stackId) {
  const parts = stackId.split(':')
  
  // Check if this is a valid ARN with enough parts
  if (parts.length >= 4) {
    return parts[3]  // Region is the 4th part (index 3)
  }
  
  return null
}

module.exports = {
  getRegionFromStackId
}