# Deploying Bible App

Hosting: Netlify site `ironcat-bible-reading` (id `ed382723-fdf4-452e-9101-c44280b155c9`) at https://ironcat-bible-reading.netlify.app. PWA installed on Steve's Pixel 8 via Chrome "Add to Home screen"; no app store.

## Release (one command)

```bash
./release.sh
```

`./release.sh` does, in order, and aborts on the first failure:

1. Preflight: on an allowed branch, clean working tree, not behind origin.
2. Bumps the version (`APP_VERSION` in `public/js/version.js` (also the service-worker cache name); fails if the file would be empty or unparseable).
3. Runs the tests (`npm test`). On failure the bump is reverted; nothing is committed or deployed.
4. Commits `Release <tag>` (version file only) and creates an annotated tag.
5. Pushes the branch and tag to GitHub.
6. Deploys with netlify-cli to **this site id only** (`netlify deploy --prod --build` (runs the netlify.toml build and Functions), falling back to a draft `--build` deploy + `netlify api restoreSiteDeploy` on 403).
7. Polls the live site until it reports the new version.

Options: `--dry-run` (read-only preview), `--version X` (explicit version), `--deploy-only` (retry deploy/verify of the current version after a failure, no bump or commit).

Edit app files and commit them first; the working tree must be clean when you run the release.

## Notes

- Requires the box's logged-in `netlify-cli` (or `NETLIFY_AUTH_TOKEN`) and git push access to GitHub (`gh auth status`).
- Secrets `BIBLE_BRAIN_KEY` and `ACCESS_PASSCODE` live only in Netlify env vars and the git-ignored local `.env`. Never commit them. This script never reads or changes env vars or site settings.
- Ground rules: stream only (no caching Bible Brain audio/text), keep copyright notices visible.
- After a release, installed phone apps need to be fully closed and reopened to pick up the new service worker.
- Rollback: restore the previous deploy in the Netlify deploy list for the site, or `git revert` the bad change and release again.
- Deploy only to this site id; never edit its settings or env vars from scripts.
