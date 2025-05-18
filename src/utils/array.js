/**
 * Combines array items with matching path and ApiId
 * @param {Array<Object>} input Array of items with path, methods, ApiId and any other properties
 * @return {Array<Object>} Combined items
 */
function combineMatchingItems(input) {
  const groupedMap = {}
  
  for (const item of input) {
    const key = item.path + "||" + item.ApiId
    
    if (!groupedMap[key]) {
      // Create a new object with all properties from original item
      const newItem = {}
      for (const prop in item) {
        if (prop === 'methods') {
          newItem[prop] = item[prop].slice() // Copy methods array
        } else {
          newItem[prop] = item[prop] // Copy all other properties
        }
      }
      groupedMap[key] = newItem
    } else {
      // Keep existing properties but merge methods
      const existing = groupedMap[key]
      for (let i = 0; i < item.methods.length; i++) {
        existing.methods.push(item.methods[i])
      }
      
      // Copy any properties that might exist in this item but not in existing
      for (const prop in item) {
        if (prop !== 'methods' && !(prop in existing)) {
          existing[prop] = item[prop]
        }
      }
    }
  }
  
  return Object.values(groupedMap)
}

module.exports = {
  combineMatchingItems
}
