function createAction(deps) {
  const {
    core,
    path,
    klawSync,
    lookup,
    axios,
    fs,
    env = process.env,
    cwd = () => process.cwd(),
    now = () => new Date(),
    inputs = {},
  } = deps;

  const DEFAULT_MAX_CONCURRENCY = 10;
  const DEFAULT_MAX_RETRIES = 3;
  const RETRY_BASE_DELAY_MS = 1000;
  const tokenRefreshBufferMs = 20 * 1000;
  const supportedDeployModes = new Set(['direct', 'staged']);
  const supportedVerifyModes = new Set(['none', 'manifest']);

  let token = null;
  let tokenExpiration = null;

  function readInput(name, options = {}) {
    if (Object.prototype.hasOwnProperty.call(inputs, name)) {
      const value = inputs[name];
      if ((value === undefined || value === null || value === '') && options.required) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value === undefined || value === null ? '' : String(value);
    }

    return core.getInput(name, options);
  }

  function readBooleanInput(name) {
    if (Object.prototype.hasOwnProperty.call(inputs, name)) {
      const value = inputs[name];
      if (typeof value === 'boolean') {
        return value;
      }

      const normalized = String(value).trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false' || normalized === '') {
        return false;
      }
      throw new Error(`Boolean input "${name}" must be true or false, received "${value}"`);
    }

    return core.getBooleanInput(name);
  }

  const clientId = readInput('clientId', { required: true });
  const clientSecret = readInput('clientSecret', { required: true });
  const sourceInput = readInput('source_dir', { required: true });
  const purge = readBooleanInput('purge');
  let outputDir = readInput('output_dir', { required: false });
  const deployMode = (readInput('deploy_mode', { required: false }) || 'direct').trim().toLowerCase();
  const verifyMode = (readInput('verify', { required: false }) || 'manifest').trim().toLowerCase();
  const rollbackOnFailure = readBooleanInput('rollback_on_failure');

  function parsePositiveInteger(value, fallback) {
    if (!value) {
      return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`Expected a positive integer but received "${value}"`);
    }

    return parsed;
  }

  const maxConcurrency = parsePositiveInteger(
    readInput('max_concurrency', { required: false }),
    DEFAULT_MAX_CONCURRENCY
  );
  const maxRetries = parsePositiveInteger(
    readInput('max_retries', { required: false }),
    DEFAULT_MAX_RETRIES
  );

  function normalizeRemotePath(remotePath) {
    const normalized = path.posix.normalize(remotePath || '/');
    if (normalized === '.') {
      return '/';
    }
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }

  function joinRemotePath() {
    return normalizeRemotePath(path.posix.join.apply(path.posix, arguments));
  }

  function trimLeadingSlash(value) {
    return value.replace(/^\/+/, '');
  }

  function trimTrailingSlash(value) {
    return value.length > 1 ? value.replace(/\/+$/, '') : value;
  }

  function makeSiblingDirPath(baseDir, suffix) {
    const normalized = trimTrailingSlash(normalizeRemotePath(baseDir));
    const parentDir = path.posix.dirname(normalized);
    const baseName = path.posix.basename(normalized);
    return joinRemotePath(parentDir, `${baseName}${suffix}`);
  }

  function buildReleaseId() {
    const sha = (env.GITHUB_SHA || 'local').slice(0, 12);
    const runId = env.GITHUB_RUN_ID || 'manual';
    const attempt = env.GITHUB_RUN_ATTEMPT || '1';
    const timestamp = now().toISOString().replace(/[-:.TZ]/g, '');
    return `${sha}-${runId}-${attempt}-${timestamp}`;
  }

  function getContentType(filePath) {
    return lookup(filePath) || 'application/octet-stream';
  }

  function normalizeMimeType(value) {
    return String(value || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
  }

  function hasComparableMimeType(value) {
    const normalized = normalizeMimeType(value);
    return normalized !== '' && normalized !== 'unknown';
  }

  function formatError(error) {
    if (error.response) {
      return `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`;
    }
    return error.message;
  }

  async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function getToken() {
    try {
      const response = await axios({
        method: 'post',
        url: 'https://api.sirv.com/v2/token',
        data: { clientId, clientSecret },
        headers: { 'content-type': 'application/json' },
      });

      const expiresInMs =
        typeof response.data.expiresIn === 'number'
          ? Math.max(response.data.expiresIn * 1000 - tokenRefreshBufferMs, 1)
          : 1180 * 1000;

      tokenExpiration = Date.now() + expiresInMs;
      return response.data.token;
    } catch (error) {
      throw new Error(`Failed to get auth token: ${formatError(error)}`);
    }
  }

  async function ensureToken() {
    if (!token || (tokenExpiration && Date.now() >= tokenExpiration)) {
      token = await getToken();
    }
    return token;
  }

  async function withRetry(fn, label) {
    let rateLimitWaitLogged = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const status = error.response && error.response.status;

        if (status === 401) {
          token = null;
          tokenExpiration = null;
        }

        if (attempt < maxRetries) {
          let delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);

          if (status === 429) {
            const resetHeader = error.response.headers['x-ratelimit-reset'];
            const resetAt = Number.parseInt(resetHeader, 10);
            if (!Number.isNaN(resetAt)) {
              const untilResetMs = Math.max(resetAt * 1000 - Date.now(), RETRY_BASE_DELAY_MS);
              delay = Math.max(delay, untilResetMs);
            }
            if (!rateLimitWaitLogged) {
              core.warning(`[${label}] Sirv rate limit hit; backing off before retrying.`);
              rateLimitWaitLogged = true;
            }
          }

          core.warning(
            `[${label}] Attempt ${attempt}/${maxRetries} failed: ${formatError(
              error
            )}. Retrying in ${delay}ms...`
          );
          await sleep(delay);
          continue;
        }

        throw new Error(`[${label}] All ${maxRetries} attempts failed. Last error: ${formatError(error)}`);
      }
    }
  }

  async function mapWithConcurrency(items, concurrency, fn) {
    const results = [];
    let index = 0;

    async function worker() {
      while (index < items.length) {
        const currentIndex = index++;
        results[currentIndex] = await fn(items[currentIndex], currentIndex);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  async function sirvRequest(config) {
    await ensureToken();
    return axios({
      ...config,
      headers: {
        authorization: `Bearer ${token}`,
        ...(config.headers || {}),
      },
    });
  }

  async function uploadFile(filePath, destPath) {
    const fileStream = fs.createReadStream(filePath);
    const response = await sirvRequest({
      method: 'post',
      url: 'https://api.sirv.com/v2/files/upload',
      params: { filename: destPath },
      headers: {
        'content-type': getContentType(filePath),
      },
      data: fileStream,
      maxBodyLength: Infinity,
    });
    return response.status;
  }

  async function deleteFile(filePath) {
    const response = await sirvRequest({
      method: 'post',
      url: 'https://api.sirv.com/v2/files/delete',
      params: { filename: filePath },
      headers: {
        'content-type': 'application/json',
      },
    });
    return response.status;
  }

  async function createDirectory(dirname) {
    const response = await sirvRequest({
      method: 'post',
      url: 'https://api.sirv.com/v2/files/mkdir',
      params: { dirname },
      headers: {
        'content-type': 'application/json',
      },
    });
    return response.status;
  }

  async function renamePath(from, to) {
    const response = await sirvRequest({
      method: 'post',
      url: 'https://api.sirv.com/v2/files/rename',
      params: { from, to },
      headers: {
        'content-type': 'application/json',
      },
    });
    return response.status;
  }

  async function statPath(filePath) {
    const response = await sirvRequest({
      method: 'get',
      url: 'https://api.sirv.com/v2/files/stat',
      params: { filename: filePath },
      headers: {
        'content-type': 'application/json',
      },
    });
    return response.data;
  }

  async function getSirvDirEntries(dirname, continuation) {
    const response = await sirvRequest({
      method: 'get',
      url: 'https://api.sirv.com/v2/files/readdir',
      params: { dirname, continuation },
      headers: {
        'content-type': 'application/json',
      },
    });
    return {
      contents: response.data.contents || [],
      continuation: response.data.continuation,
    };
  }

  async function pathExists(remotePath) {
    try {
      await withRetry(() => statPath(remotePath), `STAT ${remotePath}`);
      return true;
    } catch (error) {
      if (error.message.includes('HTTP 404')) {
        return false;
      }
      throw error;
    }
  }

  function buildManifest(sourceDir, sourceEntries, remoteRoot) {
    return sourceEntries.map((entry) => {
      const relativePath = path.relative(sourceDir, entry.path).split(path.sep).join('/');
      const stats = fs.statSync(entry.path);
      return {
        localPath: entry.path,
        relativePath,
        remotePath: joinRemotePath(remoteRoot, relativePath),
        size: stats.size,
        contentType: getContentType(entry.path),
      };
    });
  }

  async function listRemoteTree(rootDir) {
    const normalizedRoot = trimTrailingSlash(normalizeRemotePath(rootDir));
    const exists = await pathExists(normalizedRoot);
    if (!exists) {
      return [];
    }

    const files = [];
    const queue = [normalizedRoot];

    while (queue.length > 0) {
      const currentDir = queue.shift();
      let continuation = null;

      do {
        const response = await withRetry(
          () => getSirvDirEntries(currentDir, continuation),
          `READDIR ${currentDir}`
        );

        for (const entry of response.contents) {
          const entryPath = joinRemotePath(currentDir, entry.filename);
          if (entry.isDirectory) {
            queue.push(entryPath);
          } else {
            files.push({
              ...entry,
              filename: entryPath,
            });
          }
        }

        continuation = response.continuation;
      } while (continuation);
    }

    return files;
  }

  async function verifyManifest(manifest, remoteRoot, options = {}) {
    const strictExtras = Boolean(options.strictExtras);
    const remoteFiles = await listRemoteTree(remoteRoot);
    const remoteByPath = new Map(
      remoteFiles.map((entry) => [normalizeRemotePath(entry.filename), entry])
    );

    const problems = [];

    for (const file of manifest) {
      const remoteFile = remoteByPath.get(file.remotePath);
      if (!remoteFile) {
        problems.push(`Missing ${file.relativePath}`);
        continue;
      }

      const remoteSize = Number.parseInt(remoteFile.size, 10);
      if (remoteSize !== file.size) {
        problems.push(`Size mismatch for ${file.relativePath}: expected ${file.size}, got ${remoteFile.size}`);
      }

      if (
        hasComparableMimeType(remoteFile.contentType) &&
        normalizeMimeType(remoteFile.contentType) !== normalizeMimeType(file.contentType)
      ) {
        problems.push(
          `Content type mismatch for ${file.relativePath}: expected ${file.contentType}, got ${remoteFile.contentType}`
        );
      }
    }

    if (strictExtras) {
      const expectedPaths = new Set(manifest.map((file) => file.remotePath));
      for (const remoteFile of remoteFiles) {
        if (!expectedPaths.has(normalizeRemotePath(remoteFile.filename))) {
          problems.push(`Unexpected remote file ${trimLeadingSlash(remoteFile.filename)}`);
        }
      }
    }

    if (problems.length > 0) {
      throw new Error(`Manifest verification failed:\n${problems.slice(0, 50).join('\n')}`);
    }

    core.info(`Verified ${manifest.length} files in ${remoteRoot}`);
  }

  async function uploadManifest(manifest, labelPrefix) {
    let uploadSucceeded = 0;
    let uploadFailed = 0;
    const failedFiles = [];

    await mapWithConcurrency(manifest, maxConcurrency, async (file, index) => {
      try {
        const status = await withRetry(
          () => uploadFile(file.localPath, file.remotePath),
          `${labelPrefix} ${file.relativePath}`
        );
        uploadSucceeded++;

        if (index === 0 || (index + 1) % 50 === 0 || index === manifest.length - 1) {
          core.info(`[${index + 1}/${manifest.length}] Uploaded ${file.relativePath} (${status})`);
        }
      } catch (error) {
        uploadFailed++;
        failedFiles.push(file.relativePath);
        core.error(`Upload failed for ${file.relativePath}: ${error.message}`);
      }
    });

    core.info(
      `Upload summary: total=${manifest.length} succeeded=${uploadSucceeded} failed=${uploadFailed}`
    );

    if (failedFiles.length > 0) {
      throw new Error(
        `${uploadFailed} files failed to upload:\n${failedFiles.slice(0, 50).map((file) => `- ${file}`).join('\n')}`
      );
    }
  }

  async function purgeExtraFiles(remoteRoot, manifest) {
    const remoteFiles = await listRemoteTree(remoteRoot);
    const expectedFiles = new Set(manifest.map((file) => file.remotePath));
    const filesToDelete = remoteFiles
      .map((entry) => normalizeRemotePath(entry.filename))
      .filter((filePath) => !expectedFiles.has(filePath));

    if (filesToDelete.length === 0) {
      core.info(`Purge skipped: no stale files under ${remoteRoot}`);
      return;
    }

    core.info(`Purging ${filesToDelete.length} stale files from ${remoteRoot}`);
    const failedDeletes = [];

    await mapWithConcurrency(filesToDelete, maxConcurrency, async (filePath) => {
      try {
        await withRetry(() => deleteFile(filePath), `DELETE ${filePath}`);
      } catch (error) {
        failedDeletes.push(`${filePath}: ${error.message}`);
        core.error(`Failed to delete ${filePath}: ${error.message}`);
      }
    });

    if (failedDeletes.length > 0) {
      throw new Error(`Purge failed:\n${failedDeletes.slice(0, 50).join('\n')}`);
    }

    core.info(`Purge complete for ${remoteRoot}`);
  }

  function setCompatibilityOutputs(livePath) {
    core.setOutput('live_path', livePath);
    core.setOutput('object_key', livePath);
    core.setOutput('object_locations', livePath);
  }

  async function deployDirect(manifest, liveDir) {
    core.info(`Deploy mode: direct`);
    await uploadManifest(manifest, 'UPLOAD');

    if (purge) {
      await purgeExtraFiles(liveDir, manifest);
    }

    if (verifyMode === 'manifest') {
      await verifyManifest(manifest, liveDir, { strictExtras: purge });
    }

    setCompatibilityOutputs(liveDir);
  }

  async function deployStaged(manifest, liveDir) {
    const releaseId = buildReleaseId();
    const releasesRoot = makeSiblingDirPath(liveDir, '.__releases');
    const backupsRoot = makeSiblingDirPath(liveDir, '.__backups');
    const releaseDir = joinRemotePath(releasesRoot, releaseId);
    const backupDir = joinRemotePath(backupsRoot, releaseId);
    const stagedManifest = manifest.map((file) => ({
      ...file,
      remotePath: joinRemotePath(releaseDir, file.relativePath),
    }));

    core.setOutput('release_path', releaseDir);
    core.info(`Deploy mode: staged`);
    core.info(`Release path: ${releaseDir}`);

    await uploadManifest(stagedManifest, 'STAGE');

    if (verifyMode === 'manifest') {
      await verifyManifest(stagedManifest, releaseDir, { strictExtras: true });
    }

    const liveExists = await pathExists(liveDir);
    let backupCreated = false;

    if (liveExists) {
      const backupsRootExists = await pathExists(backupsRoot);
      if (!backupsRootExists) {
        await withRetry(() => createDirectory(backupsRoot), `MKDIR ${backupsRoot}`);
      }
      await withRetry(() => renamePath(liveDir, backupDir), `RENAME ${liveDir} -> ${backupDir}`);
      backupCreated = true;
      core.setOutput('backup_path', backupDir);
      core.info(`Backed up live site to ${backupDir}`);
    } else {
      core.info(`No existing live directory at ${liveDir}; first staged deploy will promote directly.`);
    }

    try {
      await withRetry(() => renamePath(releaseDir, liveDir), `RENAME ${releaseDir} -> ${liveDir}`);
    } catch (error) {
      if (backupCreated && rollbackOnFailure) {
        core.warning(`Cutover failed; attempting to restore ${backupDir} back to ${liveDir}`);
        try {
          await withRetry(() => renamePath(backupDir, liveDir), `ROLLBACK ${backupDir} -> ${liveDir}`);
        } catch (rollbackError) {
          throw new Error(
            `${error.message}\nRollback failed as well: ${rollbackError.message}`
          );
        }
      }
      throw error;
    }

    core.info(`Promoted ${releaseDir} to ${liveDir}`);
    setCompatibilityOutputs(liveDir);
  }

  async function run() {
    if (!supportedDeployModes.has(deployMode)) {
      throw new Error(
        `Unsupported deploy_mode "${deployMode}". Supported values: ${Array.from(
          supportedDeployModes
        ).join(', ')}`
      );
    }

    if (!supportedVerifyModes.has(verifyMode)) {
      throw new Error(
        `Unsupported verify "${verifyMode}". Supported values: ${Array.from(
          supportedVerifyModes
        ).join(', ')}`
      );
    }

    const sourceDir = path.resolve(cwd(), sourceInput);
    const sourceEntries = klawSync(sourceDir, { nodir: true });
    const liveDir = trimTrailingSlash(
      normalizeRemotePath(outputDir ? outputDir : trimLeadingSlash(sourceInput))
    );
    outputDir = liveDir;

    if (sourceEntries.length === 0) {
      throw new Error(`No files found in source_dir ${sourceDir}`);
    }

    const manifest = buildManifest(sourceDir, sourceEntries, liveDir);

    core.info(`=== Sirv Upload Action ===`);
    core.info(`Source: ${sourceDir}`);
    core.info(`Destination: ${liveDir}`);
    core.info(`Deploy mode: ${deployMode}`);
    core.info(`Verify mode: ${verifyMode}`);
    core.info(`Total files: ${manifest.length}`);
    core.info(`Concurrency: ${maxConcurrency}, Retries: ${maxRetries}`);

    if (deployMode === 'staged') {
      await deployStaged(manifest, liveDir);
    } else {
      await deployDirect(manifest, liveDir);
    }

    core.info(`All files uploaded successfully.`);
  }

  return {
    run,
  };
}

module.exports = {
  createAction,
};
