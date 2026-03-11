# Upload to Sirv

This branch contains the `v2` action line. It keeps the original input names, but changes deploy success semantics to fail the job when Sirv does not actually contain the uploaded site.

GitHub Action for uploading a local directory to Sirv. It now supports a staged deploy mode intended for static sites such as Docusaurus, where a partial upload is worse than a failed job.

## Recommended workflow for Docusaurus

Use `deploy_mode: staged` so the build uploads into a release folder, verifies the uploaded files, and only then promotes that release into the live Sirv path.

```yaml
name: Docs deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
      - run: npm run build

      - uses: sirv/gh-action-sirv@v2
        id: sirv
        with:
          clientId: ${{ secrets.clientId }}
          clientSecret: ${{ secrets.clientSecret }}
          source_dir: build
          output_dir: /docs
          deploy_mode: staged
          verify: manifest
          rollback_on_failure: true
          purge: false
```

The action input names are still `clientId` and `clientSecret`, so older workflows using `secrets.clientId` and `secrets.clientSecret` continue to work. If your repo uses different secret names such as `SIRV_CLIENT_ID`, keep mapping them into those same action inputs:

```yaml
with:
  clientId: ${{ secrets.SIRV_CLIENT_ID }}
  clientSecret: ${{ secrets.SIRV_CLIENT_SECRET }}
```

`staged` mode uploads to a path like `/docs.__releases/<release-id>`, verifies the uploaded files, renames the current live folder to `/docs.__backups/<release-id>`, and then promotes the staged release to `/docs`.

If `output_dir: /`, staged deploys switch the site by moving the build's top-level root entries such as `/.nojekyll`, `/assets`, `/img`, and `/index.html`. Sirv does not allow renaming `/` itself, so root deploys cannot use a single folder swap.

## Breaking changes in v2

- `verify` defaults to `manifest`, so jobs can now fail where older versions would report success after incomplete Sirv uploads.
- The action runtime is `node20` instead of `node12`.
- `object_key` and `object_locations` are now populated as deprecated aliases of `live_path`.

## Inputs

| name | description |
| --- | --- |
| `clientId` | Required. Sirv client ID. |
| `clientSecret` | Required. Sirv client secret. |
| `source_dir` | Required. Local directory to upload. |
| `output_dir` | Optional. Live destination directory in Sirv. Defaults to `/upload`. |
| `purge` | Optional boolean. In `direct` mode, delete files from Sirv that are no longer in the local build. |
| `deploy_mode` | Optional. `direct` or `staged`. Defaults to `direct`. |
| `verify` | Optional. `none` or `manifest`. Defaults to `manifest`. |
| `rollback_on_failure` | Optional boolean. In `staged` mode, restore the previous live folder if the cutover rename fails. Defaults to `true`. |
| `max_concurrency` | Optional integer. Maximum concurrent Sirv operations. Defaults to `10`. |
| `max_retries` | Optional integer. Maximum retries per Sirv API call. Defaults to `3`. |

## Outputs

| name | description |
| --- | --- |
| `live_path` | Final live Sirv directory. |
| `release_path` | Staged release directory when `deploy_mode=staged`. |
| `backup_path` | Backup directory created from the previous live release. |

## Deploy modes

### `direct`

Uploads straight to the live path. If `purge: true`, the action recursively lists the live Sirv folder and deletes stale files after upload. If `verify: manifest`, it checks that every expected file exists remotely with the expected size.

### `staged`

Uploads the build to a separate release folder first. The live path is only changed after the staged release passes verification. This is the safer mode for Docusaurus and other static sites with hashed assets.

For `output_dir: /`, the action swaps the build's top-level root entries one by one instead of renaming `/`.

## Failure behavior

- Any upload failure fails the job.
- Any manifest verification failure fails the job.
- In `staged` mode, a cutover failure attempts to restore the backup when `rollback_on_failure` is enabled.
- Sirv `401` responses clear the cached token and retry.
- Sirv `429` responses back off using the rate limit reset header when available.

## Notes

- `verify: manifest` validates path and file size. This is the main guardrail against green builds with missing site files on Sirv.
- `purge` only affects `direct` mode. `staged` mode always deploys into a fresh release path, so stale-file cleanup is not needed for the active release.
- For production use, pin the action to `@v2` or to a specific commit SHA instead of `@main`.
