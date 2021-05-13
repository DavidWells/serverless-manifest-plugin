const lodash = require('lodash')
const express = require('express')

module.exports.hello = async event => {
  console.log('lodash', lodash)
  return {
    statusCode: 200,
    body: JSON.stringify(
      {
        message: 'Go Serverless v1.0! Your function executed successfully!',
        input: event,
      },
      null,
      2
    ),
  };
};
