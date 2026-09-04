#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
COMPOSE_FILE="$SCRIPT_DIR/compose.yml"
OUTPUT_ROOT="$SCRIPT_DIR/output"
STATUS_ROOT="$SCRIPT_DIR/status"
DATA_PATH="data/seasonal-event/events.json"
CANDIDATE_PATH="data/seasonal-event/candidates.json"
CURRENT_DATA="$REPOSITORY_ROOT/$DATA_PATH"
CURRENT_CANDIDATES="$REPOSITORY_ROOT/$CANDIDATE_PATH"
BRANCH="main"
DEPLOY_KEY_PATH=${DEPLOY_KEY_PATH:-"${HOME:-/home/ubuntu}/.ssh/seasonal-event-deploy"}
KNOWN_HOSTS_PATH=${GITHUB_KNOWN_HOSTS_PATH:-"${HOME:-/home/ubuntu}/.ssh/seasonal-event-known_hosts"}
DRY_RUN=0

case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *)
    echo "usage: $0 [--dry-run]" >&2
    exit 64
    ;;
esac

for required_command in cmp cp docker flock git id mktemp; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "required command is unavailable: $required_command" >&2
    exit 69
  fi
done

if [ ! -f "$CURRENT_DATA" ]; then
  echo "current data file is missing: $CURRENT_DATA" >&2
  exit 66
fi
if [ ! -f "$CURRENT_CANDIDATES" ]; then
  echo "current candidate report is missing: $CURRENT_CANDIDATES" >&2
  exit 66
fi

if [ ! -r "$DEPLOY_KEY_PATH" ]; then
  echo "repository deploy key is not readable: $DEPLOY_KEY_PATH" >&2
  exit 77
fi
if [ ! -r "$KNOWN_HOSTS_PATH" ]; then
  echo "dedicated GitHub known-hosts file is not readable: $KNOWN_HOSTS_PATH" >&2
  exit 77
fi

mkdir -p "$OUTPUT_ROOT" "$STATUS_ROOT"
LOCK_FILE="$OUTPUT_ROOT/run-and-publish.json.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another seasonal-event publication is already running; skipping"
  exit 0
fi

STAGING_ROOT=""
cleanup() {
  exit_status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$STAGING_ROOT" ]; then
    case "$STAGING_ROOT" in
      "$OUTPUT_ROOT"/run.*) rm -rf -- "$STAGING_ROOT" ;;
      *) echo "refusing to remove unexpected staging path: $STAGING_ROOT" >&2 ;;
    esac
  fi
  exit "$exit_status"
}
trap cleanup EXIT HUP INT TERM

if [ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=no)" ]; then
  echo "tracked files in the deployment checkout are modified; refusing to publish" >&2
  exit 65
fi

REMOTE_URL=$(git -C "$REPOSITORY_ROOT" remote get-url origin)
case "$REMOTE_URL" in
  git@github.com:Miraco33/seasonal-event|git@github.com:Miraco33/seasonal-event.git|ssh://git@github.com/Miraco33/seasonal-event|ssh://git@github.com/Miraco33/seasonal-event.git) ;;
  *)
    echo "origin must be the SSH URL for Miraco33/seasonal-event; found: $REMOTE_URL" >&2
    exit 78
    ;;
esac

GIT_SSH_COMMAND="/usr/bin/ssh -i $DEPLOY_KEY_PATH -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS_PATH"
export GIT_SSH_COMMAND

git -C "$REPOSITORY_ROOT" pull --ff-only --no-rebase origin "$BRANCH"

if [ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=no)" ]; then
  echo "tracked files changed after pull; refusing to publish" >&2
  exit 65
fi

LOCAL_HEAD=$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)
REMOTE_HEAD=$(git -C "$REPOSITORY_ROOT" rev-parse "refs/remotes/origin/$BRANCH")
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "deployment checkout is not exactly at origin/$BRANCH" >&2
  exit 65
fi

STAGING_ROOT=$(mktemp -d "$OUTPUT_ROOT/run.XXXXXXXX")
CONTAINER_OUTPUT="$STAGING_ROOT/container"
PUBLISH_REPOSITORY="$STAGING_ROOT/repository"
mkdir -p "$CONTAINER_OUTPUT"
cp -- "$CURRENT_DATA" "$CONTAINER_OUTPUT/events.json"
cp -- "$CURRENT_CANDIDATES" "$CONTAINER_OUTPUT/candidates.json"

COLLECTOR_UID=$(id -u)
COLLECTOR_GID=$(id -g)
COLLECTOR_OUTPUT_DIR="$CONTAINER_OUTPUT"
COLLECTOR_STATUS_DIR="$STATUS_ROOT"
export COLLECTOR_UID COLLECTOR_GID COLLECTOR_OUTPUT_DIR COLLECTOR_STATUS_DIR

if [ "$DRY_RUN" -eq 1 ]; then
  set +e
  docker compose -f "$COMPOSE_FILE" run --rm --no-deps collector --dry-run
  COLLECTOR_EXIT=$?
  set -e
  if [ "$COLLECTOR_EXIT" -ne 0 ] && [ "$COLLECTOR_EXIT" -ne 2 ]; then
    exit "$COLLECTOR_EXIT"
  fi
  echo "dry-run completed; no commit or push was attempted"
  exit "$COLLECTOR_EXIT"
fi

set +e
docker compose -f "$COMPOSE_FILE" run --rm --no-deps collector
COLLECTOR_EXIT=$?
set -e
if [ "$COLLECTOR_EXIT" -ne 0 ] && [ "$COLLECTOR_EXIT" -ne 2 ]; then
  exit "$COLLECTOR_EXIT"
fi

GENERATED_DATA="$CONTAINER_OUTPUT/events.json"
GENERATED_CANDIDATES="$CONTAINER_OUTPUT/candidates.json"
if [ ! -s "$GENERATED_DATA" ]; then
  echo "collector did not produce a non-empty data file" >&2
  exit 65
fi
if [ ! -s "$GENERATED_CANDIDATES" ]; then
  echo "collector did not produce a non-empty candidate report" >&2
  exit 65
fi

if cmp -s "$CURRENT_DATA" "$GENERATED_DATA" && cmp -s "$CURRENT_CANDIDATES" "$GENERATED_CANDIDATES"; then
  echo "seasonal-event data and candidate report are unchanged; no commit is needed"
  exit "$COLLECTOR_EXIT"
fi

git clone --quiet --no-hardlinks --branch "$BRANCH" "$REPOSITORY_ROOT" "$PUBLISH_REPOSITORY"
git -C "$PUBLISH_REPOSITORY" remote set-url origin "$REMOTE_URL"
cp -- "$GENERATED_DATA" "$PUBLISH_REPOSITORY/$DATA_PATH"
cp -- "$GENERATED_CANDIDATES" "$PUBLISH_REPOSITORY/$CANDIDATE_PATH"
git -C "$PUBLISH_REPOSITORY" add -- "$DATA_PATH" "$CANDIDATE_PATH"

if git -C "$PUBLISH_REPOSITORY" diff --cached --quiet -- "$DATA_PATH" "$CANDIDATE_PATH"; then
  echo "seasonal-event data has no Git-visible change; no commit is needed"
  exit "$COLLECTOR_EXIT"
fi

git -C "$PUBLISH_REPOSITORY" \
  -c user.name="seasonal-event collector" \
  -c user.email="seasonal-event-collector@users.noreply.github.com" \
  -c commit.gpgSign=false \
  commit --quiet -m "data: update seasonal events" -- "$DATA_PATH" "$CANDIDATE_PATH"
git -C "$PUBLISH_REPOSITORY" push origin "HEAD:refs/heads/$BRANCH"

# The remote is already authoritative after a successful push. Keep the long-lived
# checkout current when possible; a later invocation will retry this fast-forward.
if ! git -C "$REPOSITORY_ROOT" pull --ff-only --no-rebase origin "$BRANCH"; then
  echo "warning: data was published, but the deployment checkout could not fast-forward" >&2
fi

echo "seasonal-event data was committed and pushed successfully"
exit "$COLLECTOR_EXIT"
