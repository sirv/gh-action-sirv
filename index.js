const core = require('@actions/core');
const path = require('path');
const klawSync = require('klaw-sync');
const { lookup } = require('mime-types');
const axios = require('axios');
const fs = require('fs');
const { createAction } = require('./lib/sirv-action');

const action = createAction({
  core,
  path,
  klawSync,
  lookup,
  axios,
  fs,
  env: process.env,
  cwd: () => process.cwd(),
  now: () => new Date(),
});

if (require.main === module) {
  action.run().catch((error) => {
    core.setFailed(error.message);
    process.exit(1);
  });
}

module.exports = {
  createAction,
};
