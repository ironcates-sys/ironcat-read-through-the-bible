#!/usr/bin/env bash
# release.sh - standard release for Bible App (ironcat-read-through-the-bible).
# Bumps version -> runs tests -> commits + tags -> pushes -> deploys to THIS app's Netlify site only -> verifies live version.
# See DEPLOY.md. Try `./release.sh --dry-run` first.
set -euo pipefail

# ---- CONFIG (app specific) -----------------------------------------------
APP_NAME="Bible App"
SITE_ID="ed382723-fdf4-452e-9101-c44280b155c9"                           # ironcat-bible-reading (team ironcates). Deploy only; never edit its settings/env vars.
LIVE_URL="https://ironcat-bible-reading.netlify.app"
VERSION_FILE="public/js/version.js"                   # APP_VERSION here is also the service-worker cache name
VERSION_REGEX="var APP_VERSION = '([^']+)'"
VERIFY_PATH="js/version.js"
TEST_CMD="npm test"
DEPLOY_MODE="prod-fallback"                           # try --prod; on 403 use draft + restoreSiteDeploy
DEPLOY_SOURCE="build"                                 # netlify deploy --build (runs netlify.toml build + functions)
ALLOWED_BRANCHES="main scaffold"                      # 'scaffold' is the working branch until it is merged to main
write_version() { sed -i -E "s/^(var APP_VERSION = ')[^']+(';)/\1$1\2/" "$VERSION_FILE"; }
# Guard against the empty/garbled version.js incident: must be non-empty, exactly one APP_VERSION line, parseable.
check_version_file() {
  [ -s "$VERSION_FILE" ] || die "$VERSION_FILE is empty - refusing to continue"
  [ "$(grep -c '^var APP_VERSION = ' "$VERSION_FILE")" = 1 ] || die "$VERSION_FILE must contain exactly one APP_VERSION line"
  [ -n "$(current_version)" ] || die "$VERSION_FILE has no parseable APP_VERSION"
}

# ---------------------------------------------------------------------------
# Shared release logic (identical across the IronCat apps). Edit CONFIG above.
# ---------------------------------------------------------------------------
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$PWD"
NETLIFY_CLI="${NETLIFY_CLI:-npx -y netlify-cli}"   # uses the box's logged-in CLI (or NETLIFY_AUTH_TOKEN)

DRY_RUN=0; DEPLOY_ONLY=0; FORCE_VERSION=""
usage() {
  cat <<USAGE
Usage: ./release.sh [--dry-run] [--version <ver>] [--deploy-only]
  (no args)       bump version -> test -> commit+tag -> push -> deploy -> verify live
  --dry-run       read-only: show what would happen (no edits, tests, commits, pushes or deploys)
  --version V     use V instead of auto-increment (same format as current, e.g. $(current_version 2>/dev/null || echo X))
  --deploy-only   skip bump/test/commit; deploy the current tree and verify (use to retry a failed deploy)
Target: ${APP_NAME} -> Netlify site ${SITE_ID} (${LIVE_URL}) only.
USAGE
}
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --deploy-only) DEPLOY_ONLY=1 ;;
    --version) shift; FORCE_VERSION="${1:-}"; [ -n "$FORCE_VERSION" ] || { echo "--version needs a value" >&2; exit 2; } ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }

extract_version() { sed -nE "s/.*${VERSION_REGEX}.*/\1/p" | head -n1; }
current_version() { extract_version < "$VERSION_FILE"; }

next_version() {
  local cur="$1"
  if [[ "$cur" =~ ^v([0-9]+)$ ]]; then echo "v$((BASH_REMATCH[1] + 1))"
  elif [[ "$cur" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then echo "${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"
  else die "Cannot auto-increment version '$cur'; pass --version"; fi
}

# ---- preflight ------------------------------------------------------------
for c in git node npx curl sed; do command -v "$c" >/dev/null || die "missing required command: $c"; done
[ -f "$VERSION_FILE" ] || die "version file $VERSION_FILE not found"
git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
case " $ALLOWED_BRANCHES " in *" $BRANCH "*) ;; *) die "on branch '$BRANCH'; releases allowed from: $ALLOWED_BRANCHES" ;; esac
if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  die "working tree not clean; commit or stash first (the release commit must contain only the version bump)"
fi
log "Fetching origin"; git fetch --quiet origin || die "git fetch failed (is gh/git auth working?)"
if git rev-parse -q --verify "origin/$BRANCH" >/dev/null; then
  [ "$(git rev-list --count "HEAD..origin/$BRANCH")" = 0 ] || die "local $BRANCH is behind origin/$BRANCH; pull/rebase first"
fi

OLD="$(current_version)"; [ -n "$OLD" ] || die "could not read current version from $VERSION_FILE"
if [ "$DEPLOY_ONLY" = 1 ]; then NEW="$OLD"
elif [ -n "$FORCE_VERSION" ]; then NEW="$FORCE_VERSION"; [ "$NEW" != "$OLD" ] || die "--version equals current ($OLD)"; next_version "$OLD" >/dev/null
else NEW="$(next_version "$OLD")"; fi
TAG="v${NEW#v}"
if [ "$DEPLOY_ONLY" = 0 ] && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then die "tag $TAG already exists"; fi
log "${APP_NAME}: $OLD -> $NEW (tag $TAG) on branch $BRANCH, site $SITE_ID"

# ---- helpers --------------------------------------------------------------
STAGE=""
cleanup() { [ -n "$STAGE" ] && rm -rf "$STAGE"; return 0; }
trap cleanup EXIT

make_stage() {   # static apps: stage exactly the tracked files that ship (never tests/tools/audio-src/etc.)
  STAGE="$(mktemp -d)"
  git ls-files -z | grep -zvE "$STAGE_EXCLUDE" | xargs -0 -I{} cp --parents {} "$STAGE"/
  [ -f "$STAGE/sw.js" ] && [ -f "$STAGE/index.html" ] || die "staging looks wrong (sw.js/index.html missing)"
  [ "$(extract_version < "$STAGE/sw.js")" = "$NEW" ] || [ "$DRY_RUN" = 1 ] || die "staged sw.js version != $NEW"
  log "Staged $(find "$STAGE" -type f | wc -l) files, $(du -sh "$STAGE" | cut -f1) -> $STAGE"
}

is_403() { grep -qiE '(^|[^0-9])403([^0-9]|$)|forbidden' <<<"$1"; }

deploy_draft_then_restore() {   # $@ = extra netlify deploy args (e.g. --dir X / --build)
  log "Draft deploy to site $SITE_ID"
  local out id
  out="$($NETLIFY_CLI deploy "$@" --site "$SITE_ID" --message "release $TAG" --json)" || die "draft deploy failed"
  id="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.indexOf("{");const j=JSON.parse(s.slice(i));process.stdout.write(j.deploy_id||j.id||"")})')"
  [ -n "$id" ] || die "could not read deploy_id from draft deploy output"
  log "Draft deploy $id created; making it live via restoreSiteDeploy"
  $NETLIFY_CLI api restoreSiteDeploy --data "{\"site_id\":\"$SITE_ID\",\"deploy_id\":\"$id\"}" >/dev/null || die "restoreSiteDeploy failed for deploy $id (draft is uploaded but NOT live)"
}

deploy_site() {   # $@ = deploy source args (--dir X | --build)
  if [ "$DEPLOY_MODE" = "draft-restore" ]; then deploy_draft_then_restore "$@"; return; fi
  log "Deploying to production on site $SITE_ID"
  local out rc=0
  out="$($NETLIFY_CLI deploy --prod "$@" --site "$SITE_ID" --message "release $TAG" 2>&1)" || rc=$?
  if [ "$rc" = 0 ]; then echo "$out" | tail -n 8; return; fi
  echo "$out" | tail -n 15 >&2
  if is_403 "$out"; then warn "--prod returned 403/Forbidden; falling back to draft deploy + restoreSiteDeploy"; deploy_draft_then_restore "$@"
  else die "deploy failed (not a 403; not retrying)"; fi
}

verify_live() {
  log "Verifying live ${LIVE_URL}/${VERIFY_PATH} reports $NEW"
  local i got
  for i in $(seq 1 12); do
    got="$(curl -fsS -H 'Cache-Control: no-cache' "${LIVE_URL}/${VERIFY_PATH}?_=$(date +%s)" 2>/dev/null | extract_version || true)"
    if [ "$got" = "$NEW" ]; then log "OK: live version is $got"; return 0; fi
    echo "   attempt $i/12: live reports '${got:-<none>}', want '$NEW'"; sleep 5
  done
  die "live version never matched $NEW (last saw '${got:-<none>}'). Check the Netlify deploy list; rollback = restore the previous deploy there or 'git revert' + ./release.sh"
}

# ---- dry run --------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  log "DRY RUN: nothing below is executed"
  [ "$DEPLOY_ONLY" = 1 ] || echo "[dry-run] set version in $VERSION_FILE: $OLD -> $NEW"
  type pre_test >/dev/null 2>&1 && echo "[dry-run] preflight for tests (pre_test)"
  [ "$DEPLOY_ONLY" = 1 ] || echo "[dry-run] run tests: $TEST_CMD   (abort + revert version on failure)"
  [ "$DEPLOY_ONLY" = 1 ] || echo "[dry-run] git commit -m 'Release $TAG' -- $VERSION_FILE && git tag -a $TAG"
  [ "$DEPLOY_ONLY" = 1 ] || echo "[dry-run] git push origin $BRANCH && git push origin $TAG"
  if [ "$DEPLOY_SOURCE" = "stage" ]; then
    make_stage; (cd "$STAGE" && find . -type f | sort | sed 's/^/[dry-run] would deploy: /')
    echo "[dry-run] deploy --dir <stage> --site $SITE_ID ($DEPLOY_MODE)"
  else
    echo "[dry-run] deploy --build --site $SITE_ID ($DEPLOY_MODE)"
  fi
  echo "[dry-run] verify ${LIVE_URL}/${VERIFY_PATH} == $NEW"
  exit 0
fi

# ---- real release ---------------------------------------------------------
if [ "$DEPLOY_ONLY" = 0 ]; then
  log "Bumping version in $VERSION_FILE"
  trap 'git checkout -- "$VERSION_FILE" 2>/dev/null || true; cleanup' EXIT   # revert bump if anything fails before commit
  write_version "$NEW"
  [ "$(current_version)" = "$NEW" ] || die "version bump did not apply to $VERSION_FILE"
  check_version_file
  type pre_test >/dev/null 2>&1 && pre_test
  log "Running tests: $TEST_CMD"
  bash -c "$TEST_CMD" || die "tests failed; version bump reverted, nothing committed or deployed"
  log "Committing and tagging $TAG"
  git add -- "$VERSION_FILE"
  git commit -q -m "Release $TAG" -- "$VERSION_FILE"
  git tag -a "$TAG" -m "$APP_NAME $TAG"
  trap cleanup EXIT   # committed: no longer revert
  log "Pushing $BRANCH and $TAG"
  git push origin "$BRANCH" && git push origin "$TAG" || die "push failed (commit+tag exist locally). Fix auth then: git push origin $BRANCH && git push origin $TAG && ./release.sh --deploy-only"
else
  check_version_file
fi

if [ "$DEPLOY_SOURCE" = "stage" ]; then make_stage; deploy_site --dir "$STAGE"
else check_version_file; deploy_site --build; fi
verify_live
log "Released ${APP_NAME} $NEW"
