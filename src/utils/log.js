const util = require('util')

let DEBUG = process.argv.includes('--debug') ? true : false
// DEBUG = true
const logger = DEBUG ? deepLog : () => {}

function logValue(value, isFirst, isLast) {
  const prefix = `${isFirst ? '> ' : ''}`
  if (typeof value === 'object') {
    console.log(`${util.inspect(value, false, null, true)}\n`)
    return
  }
  if (isFirst) {
    console.log(`\n\x1b[33m${prefix}${value}\x1b[0m`)
    return
  }
  console.log((typeof value === 'string' && value.includes('\n')) ? `\`${value}\`` : value)
  // isLast && console.log(`\x1b[37m\x1b[1m${'─'.repeat(94)}\x1b[0m\n`)
}

function deepLog() {
  for (let i = 0; i < arguments.length; i++) logValue(arguments[i], i === 0, i === arguments.length - 1)
}

function logMeta(fn) {
  return function (...args) {
    console.log(`Entering:`, fn.name, `with arguments:`, args)
    const result = fn(...args)
    console.log(`Exiting:`, fn.name, `with result:`, result)
    return result
  }
}

function measureTime(targetFn) {
  return function (...args) {
    const start = performance.now()
    const result = targetFn.apply(this, args)
    const end = performance.now()
    console.log(`Execution time for ${targetFn.name}: ${end - start}ms`)
    return result
  }
}

module.exports = {
  deepLog,
  logMeta,
  measureTime
}