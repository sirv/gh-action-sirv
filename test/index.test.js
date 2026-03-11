const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createAction } = require('../lib/sirv-action');

function createTempSite(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sirv-action-'));

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  return dir;
}

function listFiles(rootDir, options) {
  const entries = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        entries.push({ path: fullPath });
      }
    }
  }

  walk(rootDir);
  return entries;
}

function createCore() {
  const outputs = {};
  return {
    outputs,
    messages: {
      info: [],
      warning: [],
      error: [],
    },
    getInput() {
      throw new Error('Tests should provide inputs directly');
    },
    getBooleanInput() {
      throw new Error('Tests should provide inputs directly');
    },
    info(message) {
      this.messages.info.push(message);
    },
    warning(message) {
      this.messages.warning.push(message);
    },
    error(message) {
      this.messages.error.push(message);
    },
    setOutput(name, value) {
      outputs[name] = value;
    },
  };
}

function createAxios(handler) {
  const calls = [];
  const axios = async (config) => {
    calls.push(config);
    return handler(config, calls);
  };
  axios.calls = calls;
  return axios;
}

function httpError(status, data, headers) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = {
    status,
    data,
    headers: headers || {},
  };
  return error;
}

function lookupMimeType(filePath) {
  if (filePath.endsWith('.html')) {
    return 'text/html';
  }

  if (filePath.endsWith('.js')) {
    return 'application/javascript';
  }

  return 'application/octet-stream';
}

function createReadStream(filePath) {
  return Readable.from(fs.readFileSync(filePath));
}

test('direct mode stays compatible and does not purge when purge=false', async () => {
  const siteDir = createTempSite({
    'index.html': '<html></html>',
  });
  const fileSize = fs.statSync(path.join(siteDir, 'index.html')).size;
  const core = createCore();
  const axios = createAxios(async (config) => {
    if (config.url.endsWith('/token')) {
      return { data: { token: 'token', expiresIn: 3600 } };
    }

    if (config.url.endsWith('/files/upload')) {
      assert.equal(config.params.filename, '/docs/index.html');
      return { status: 200, data: {} };
    }

    if (config.url.endsWith('/files/stat')) {
      assert.equal(config.params.filename, '/docs');
      return { data: {} };
    }

    if (config.url.endsWith('/files/readdir')) {
      assert.equal(config.params.dirname, '/docs');
      return {
        data: {
          contents: [
            {
              filename: 'index.html',
              isDirectory: false,
              size: String(fileSize),
              contentType: 'text/html; charset=utf-8',
            },
          ],
        },
      };
    }

    throw new Error(`Unexpected request: ${config.method} ${config.url}`);
  });

  const action = createAction({
    core,
    path,
    klawSync: listFiles,
    lookup: lookupMimeType,
    axios,
    fs: {
      ...fs,
      createReadStream,
    },
    cwd: () => process.cwd(),
    env: {},
    now: () => new Date('2026-03-11T12:00:00.000Z'),
    inputs: {
      clientId: 'id',
      clientSecret: 'secret',
      source_dir: siteDir,
      output_dir: '/docs',
      purge: 'false',
      deploy_mode: 'direct',
      verify: 'manifest',
      rollback_on_failure: 'true',
      max_concurrency: '2',
      max_retries: '1',
    },
  });

  await action.run();

  assert.equal(core.outputs.live_path, '/docs');
  assert.equal(core.outputs.object_key, '/docs');
  assert.equal(core.outputs.object_locations, '/docs');
  assert.equal(core.outputs.release_path, undefined);
  assert.equal(core.outputs.backup_path, undefined);
  assert.equal(
    axios.calls.filter((call) => call.url.endsWith('/files/delete')).length,
    0
  );
  assert.equal(
    axios.calls.filter((call) => call.url.endsWith('/files/rename')).length,
    0
  );
});

test('staged mode restores the backup when cutover fails', async () => {
  const siteDir = createTempSite({
    'index.html': '<html>docs</html>',
  });
  const fileSize = fs.statSync(path.join(siteDir, 'index.html')).size;
  const core = createCore();
  const releaseId = 'abcdef123456-42-1-20260311120000000';
  const releaseDir = `/docs.__releases/${releaseId}`;
  const backupDir = `/docs.__backups/${releaseId}`;
  const renameCalls = [];

  const axios = createAxios(async (config) => {
    if (config.url.endsWith('/token')) {
      return { data: { token: 'token', expiresIn: 3600 } };
    }

    if (config.url.endsWith('/files/upload')) {
      assert.equal(config.params.filename, `${releaseDir}/index.html`);
      return { status: 200, data: {} };
    }

    if (config.url.endsWith('/files/stat')) {
      if (config.params.filename === releaseDir || config.params.filename === '/docs') {
        return { data: {} };
      }

      if (config.params.filename === '/docs.__backups') {
        throw httpError(404, { message: 'Not found' });
      }

      throw new Error(`Unexpected stat path: ${config.params.filename}`);
    }

    if (config.url.endsWith('/files/readdir')) {
      assert.equal(config.params.dirname, releaseDir);
      return {
        data: {
          contents: [
            {
              filename: 'index.html',
              isDirectory: false,
              size: String(fileSize),
              contentType: 'text/html',
            },
          ],
        },
      };
    }

    if (config.url.endsWith('/files/mkdir')) {
      assert.equal(config.params.dirname, '/docs.__backups');
      return { status: 200, data: {} };
    }

    if (config.url.endsWith('/files/rename')) {
      renameCalls.push([config.params.from, config.params.to]);

      if (config.params.from === '/docs' && config.params.to === backupDir) {
        return { status: 200, data: {} };
      }

      if (config.params.from === releaseDir && config.params.to === '/docs') {
        throw httpError(500, { message: 'rename failed' });
      }

      if (config.params.from === backupDir && config.params.to === '/docs') {
        return { status: 200, data: {} };
      }
    }

    throw new Error(`Unexpected request: ${config.method} ${config.url}`);
  });

  const action = createAction({
    core,
    path,
    klawSync: listFiles,
    lookup: lookupMimeType,
    axios,
    fs: {
      ...fs,
      createReadStream,
    },
    cwd: () => process.cwd(),
    env: {
      GITHUB_SHA: 'abcdef1234567890',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
    },
    now: () => new Date('2026-03-11T12:00:00.000Z'),
    inputs: {
      clientId: 'id',
      clientSecret: 'secret',
      source_dir: siteDir,
      output_dir: '/docs',
      purge: 'false',
      deploy_mode: 'staged',
      verify: 'manifest',
      rollback_on_failure: 'true',
      max_concurrency: '2',
      max_retries: '1',
    },
  });

  await assert.rejects(action.run(), /rename failed/);

  assert.equal(core.outputs.release_path, releaseDir);
  assert.equal(core.outputs.backup_path, backupDir);
  assert.equal(core.outputs.live_path, undefined);
  assert.deepEqual(renameCalls, [
    ['/docs', backupDir],
    [releaseDir, '/docs'],
    [backupDir, '/docs'],
  ]);
});

test('manifest verification fails the run when Sirv is missing a file', async () => {
  const siteDir = createTempSite({
    'index.html': '<html></html>',
  });
  const core = createCore();
  const axios = createAxios(async (config) => {
    if (config.url.endsWith('/token')) {
      return { data: { token: 'token', expiresIn: 3600 } };
    }

    if (config.url.endsWith('/files/upload')) {
      return { status: 200, data: {} };
    }

    if (config.url.endsWith('/files/stat')) {
      return { data: {} };
    }

    if (config.url.endsWith('/files/readdir')) {
      return {
        data: {
          contents: [],
        },
      };
    }

    throw new Error(`Unexpected request: ${config.method} ${config.url}`);
  });

  const action = createAction({
    core,
    path,
    klawSync: listFiles,
    lookup: lookupMimeType,
    axios,
    fs: {
      ...fs,
      createReadStream,
    },
    cwd: () => process.cwd(),
    env: {},
    now: () => new Date('2026-03-11T12:00:00.000Z'),
    inputs: {
      clientId: 'id',
      clientSecret: 'secret',
      source_dir: siteDir,
      output_dir: '/docs',
      purge: 'false',
      deploy_mode: 'direct',
      verify: 'manifest',
      rollback_on_failure: 'true',
      max_concurrency: '2',
      max_retries: '1',
    },
  });

  await assert.rejects(action.run(), /Manifest verification failed:\nMissing index\.html/);
});
