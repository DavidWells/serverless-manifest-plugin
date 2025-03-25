const fs = require('fs')

function fsExistsSync(myDir) {
  try {
    fs.accessSync(myDir)
    return true
  } catch (e) {
    return false
  }
}

module.exports = {
  fsExistsSync
}