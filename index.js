const core = require('@actions/core');
const path = require('path');
const klawSync = require('klaw-sync');
const { lookup } = require('mime-types');
const axios = require('axios');
const fs = require('fs');

const clientId = core.getInput('clientId', { required: true });
const clientSecret = core.getInput('clientSecret', { required: true });
const SOURCE_DIR = core.getInput('source_dir', { required: true });
const PURGE = core.getInput('purge', { required: false });
let OUTPUT_DIR = core.getInput('output_dir', { required: false });

const MAX_CONCURRENCY = 10;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

const paths = klawSync(SOURCE_DIR, { nodir: true });

let token = null;
let tokenExpiration = null;

async function getToken() {
  try {
    const response = await axios({
      method: 'post',
      url: 'https://api.sirv.com/v2/token',
      data: { clientId, clientSecret },
      headers: { 'Content-Type': 'application/json' },
    });
    return response.data.token;
  } catch (e) {
    const msg = e.response
      ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`
      : e.message;
    throw new Error(`Failed to get auth token: ${msg}`);
  }
}

async function ensureToken() {
  if (!token || (tokenExpiration && Date.now() >= tokenExpiration)) {
    token = await getToken();
    tokenExpiration = Date.now() + 1180 * 1000;
  }
  return token;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e.response
        ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`
        : e.message;

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        core.warning(`[${label}] Attempt ${attempt}/${MAX_RETRIES} failed: ${msg}. Retrying in ${delay}ms...`);
        await sleep(delay);
      } else {
        throw new Error(`[${label}] All ${MAX_RETRIES} attempts failed. Last error: ${msg}`);
      }
    }
  }
}

// Run async tasks with limited concurrency
async function mapWithConcurrency(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

async function uploadFile(filePath, destPath) {
  await ensureToken();
  const fileStream = fs.createReadStream(filePath);
  const response = await axios({
    method: 'post',
    url: 'https://api.sirv.com/v2/files/upload',
    params: { filename: destPath },
    headers: {
      authorization: 'Bearer ' + token,
      ContentType: lookup(filePath) || 'application/octet-stream',
    },
    data: fileStream,
  });
  return response.status;
}

async function deleteFile(filePath) {
  await ensureToken();
  const response = await axios({
    method: 'post',
    url: 'https://api.sirv.com/v2/files/delete',
    params: { filename: filePath },
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
  });
  return response.status;
}

async function getSirvFiles(dirname, continuation) {
  await ensureToken();
  const response = await axios({
    method: 'get',
    url: 'https://api.sirv.com/v2/files/readdir',
    params: { dirname, continuation },
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
  });
  const files = response.data.contents.filter((entry) => !entry.isDirectory);
  return { files, continuation: response.data.continuation };
}

async function run() {
  const sourceDir = path.join(process.cwd(), SOURCE_DIR);
  if (!OUTPUT_DIR) {
    OUTPUT_DIR = SOURCE_DIR;
  }

  const totalFiles = paths.length;
  core.info(`=== Sirv Upload Action ===`);
  core.info(`Source: ${sourceDir}`);
  core.info(`Destination: ${OUTPUT_DIR}`);
  core.info(`Total files to upload: ${totalFiles}`);
  core.info(`Concurrency: ${MAX_CONCURRENCY}, Retries: ${MAX_RETRIES}`);

  // --- Purge phase ---
  if (PURGE) {
    core.info(`\n--- Purge: fetching existing files from Sirv ---`);
    let sirvFiles = [];
    let continuation = null;

    try {
      do {
        const response = await withRetry(
          () => getSirvFiles('/' + OUTPUT_DIR, continuation),
          'readdir'
        );
        sirvFiles = sirvFiles.concat(response.files);
        continuation = response.continuation;
      } while (continuation);
    } catch (e) {
      core.warning(`Failed to fetch Sirv file list for purge: ${e.message}. Skipping purge.`);
      sirvFiles = [];
    }

    core.info(`Files on Sirv: ${sirvFiles.length}`);

    const repoFiles = new Set(
      paths.map((p) => '/' + path.join(OUTPUT_DIR, path.relative(sourceDir, p.path)))
    );

    const filesToDelete = sirvFiles
      .filter((file) => !repoFiles.has(file.filename))
      .map((file) => file.filename);

    core.info(`Files to delete: ${filesToDelete.length}`);

    if (filesToDelete.length > 0) {
      let deleteSucceeded = 0;
      let deleteFailed = 0;

      await mapWithConcurrency(filesToDelete, MAX_CONCURRENCY, async (filePath) => {
        try {
          await withRetry(() => deleteFile(filePath), `DELETE ${filePath}`);
          deleteSucceeded++;
        } catch (e) {
          deleteFailed++;
          core.warning(`Failed to delete ${filePath}: ${e.message}`);
        }
      });

      core.info(`Purge complete: ${deleteSucceeded} deleted, ${deleteFailed} failed`);
    }
  }

  // --- Upload phase ---
  core.info(`\n--- Uploading ${totalFiles} files ---`);

  let uploadSucceeded = 0;
  let uploadFailed = 0;
  const failedFiles = [];

  await mapWithConcurrency(paths, MAX_CONCURRENCY, async (p, i) => {
    const destPath = '/' + path.join(OUTPUT_DIR, path.relative(sourceDir, p.path));
    const shortPath = path.relative(sourceDir, p.path);

    try {
      const status = await withRetry(
        () => uploadFile(p.path, destPath),
        `UPLOAD ${shortPath}`
      );
      uploadSucceeded++;

      // Log progress every 50 files + first and last
      if (i === 0 || (i + 1) % 50 === 0 || i === totalFiles - 1) {
        core.info(`[${i + 1}/${totalFiles}] ✓ ${shortPath} (${status})`);
      }
    } catch (e) {
      uploadFailed++;
      failedFiles.push(shortPath);
      core.error(`✗ ${shortPath}: ${e.message}`);
    }
  });

  // --- Summary ---
  core.info(`\n=== Upload Summary ===`);
  core.info(`Total: ${totalFiles} | Succeeded: ${uploadSucceeded} | Failed: ${uploadFailed}`);

  if (failedFiles.length > 0) {
    core.info(`\nFailed files:`);
    failedFiles.forEach((f) => core.error(`  - ${f}`));
    throw new Error(`${uploadFailed} of ${totalFiles} files failed to upload`);
  }

  core.info(`\nAll files uploaded successfully.`);
}

run().catch((err) => {
  core.setFailed(err.message);
  process.exit(1);
});
