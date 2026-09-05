#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="${SCRIPT_DIR}"
LOG_DIR="${VALIDATION_LOG_DIR:-${SCRIPT_DIR}/../validation-logs}"
LOG_FILE="${LOG_DIR}/trunk-ci-sdk-validation-$(date '+%Y%m%d-%H%M%S').log"

WORK_DIR=""
START_BRANCH=""
START_COMMIT=""

mkdir -p "${LOG_DIR}"

# Everything printed from here on is written both to the terminal
# and to a persistent validation log outside the repository by default.
exec > >(tee -a "${LOG_FILE}") 2>&1

cleanup() {
  local exit_code=$?

  # Prevent recursive traps while cleaning up.
  trap - EXIT INT TERM

  echo
  echo "==> Cleanup"

  if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
    rm -rf "${WORK_DIR}"
    echo "Removed temporary package-validation workspace"
  fi

  echo

  if (( exit_code == 0 )); then
    echo "========================================"
    echo " Trunk CI SDK validation SUCCESSFUL"
    echo "========================================"
  else
    echo "========================================"
    echo " Trunk CI SDK validation FAILED"
    echo "========================================"
  fi

  echo
  echo "Validation log:"
  echo "  ${LOG_FILE}"

  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

echo "========================================"
echo " Trunk CI SDK validation"
echo "========================================"
echo
echo "Started: $(date --iso-8601=seconds)"
echo "Log:     ${LOG_FILE}"
echo

if ! git -C "${REPO_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: Expected Trunk CI SDK Git worktree at:"
  echo "  ${REPO_DIR}"
  exit 1
fi

REPO_TOPLEVEL="$(git -C "${REPO_DIR}" rev-parse --show-toplevel)"
REPO_TOPLEVEL="$(cd -- "${REPO_TOPLEVEL}" && pwd -P)"
if [[ "${REPO_TOPLEVEL}" != "${REPO_DIR}" ]]; then
  echo "ERROR: validate.sh must live at the repository worktree root"
  echo "Script root: ${REPO_DIR}"
  echo "Git root:    ${REPO_TOPLEVEL}"
  exit 1
fi

cd "${REPO_DIR}"

START_BRANCH="$(git branch --show-current)"
START_COMMIT="$(git rev-parse HEAD)"

echo "==> Repository"
echo "Path:   ${REPO_DIR}"
echo "Branch: ${START_BRANCH:-<detached>}"
echo "Commit: ${START_COMMIT}"
echo

INITIAL_STATUS="$(git status --porcelain=v1 --untracked-files=all)"
if [[ -n "${INITIAL_STATUS}" ]]; then
  echo "ERROR: Working tree must be clean for merge-gate validation:"
  git status --short
  exit 1
fi

echo "Working tree is clean"
echo

echo "==> Required tools"

for command in git node npm find; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "ERROR: Required command not found: ${command}"
    exit 1
  fi
done

MIN_NODE_VERSION="22.18.0"

if ! node - "${MIN_NODE_VERSION}" <<'NODE'
const current = process.versions.node.split('.').map(Number);
const required = process.argv[2].split('.').map(Number);
for (let index = 0; index < Math.max(current.length, required.length); index += 1) {
  const left = current[index] ?? 0;
  const right = required[index] ?? 0;
  if (left > right) process.exit(0);
  if (left < right) process.exit(1);
}
NODE
then
  echo "ERROR: Trunk CI SDK requires Node >= ${MIN_NODE_VERSION}"
  echo "Current Node: $(node --version)"
  exit 1
fi

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo "git:  $(git --version)"
echo

if [[ ! -f "package-lock.json" ]]; then
  echo "ERROR: package-lock.json is required for reproducible merge-gate validation"
  exit 1
fi

echo "==> Dependencies"
npm ci --no-audit --no-fund

echo
echo "==> Full source validation"
npm run check

echo
echo "==> Published package smoke test"
WORK_DIR="$(mktemp -d /tmp/trunk-ci-sdk-validation.XXXXXX)"
PACK_DIR="${WORK_DIR}/pack"
CONSUMER_DIR="${WORK_DIR}/consumer"
mkdir -p "${PACK_DIR}" "${CONSUMER_DIR}"

npm pack --pack-destination "${PACK_DIR}"

TARBALL="$(find "${PACK_DIR}" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
if [[ -z "${TARBALL}" || ! -f "${TARBALL}" ]]; then
  echo "ERROR: npm pack did not produce a package tarball"
  exit 1
fi

echo "Packed: ${TARBALL}"

cat > "${CONSUMER_DIR}/package.json" <<'EOF_CONSUMER'
{
  "name": "trunk-ci-sdk-validation-consumer",
  "private": true,
  "type": "module"
}
EOF_CONSUMER

cd "${CONSUMER_DIR}"
npm install \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  --package-lock=false \
  "${TARBALL}"

node --input-type=module <<'NODE'
import {
  canonicalWorkflowPlan,
  checkout,
  job,
  run,
  workflow,
  workflowPlanDigest,
} from 'trunk-ci-sdk';

const plan = workflow({
  test: job([checkout(), run('npm test')]),
});

const expectedCanonical = '{"jobs":{"test":{"steps":[{"kind":"checkout"},{"command":"npm test","kind":"run"}]}},"version":1}';
const expectedDigest = '295d807fb27dd4da8021c763e4f2aa34bc7712bc9cf9087aa7c0b4861975afc7';

if (canonicalWorkflowPlan(plan) !== expectedCanonical) {
  throw new Error('published package produced an unexpected canonical workflow plan');
}

if (await workflowPlanDigest(plan) !== expectedDigest) {
  throw new Error('published package produced an unexpected workflow digest');
}

console.log('Published package import and pinned contract: PASS');
NODE

cd "${REPO_DIR}"

echo
echo "==> Checking repository after validation"

if [[ "$(git rev-parse HEAD)" != "${START_COMMIT}" ]]; then
  echo "ERROR: Repository HEAD changed during validation"
  echo "Before: ${START_COMMIT}"
  echo "After:  $(git rev-parse HEAD)"
  exit 1
fi

if [[ "$(git branch --show-current)" != "${START_BRANCH}" ]]; then
  echo "ERROR: Repository branch changed during validation"
  echo "Before: ${START_BRANCH:-<detached>}"
  echo "After:  $(git branch --show-current)"
  exit 1
fi

FINAL_STATUS="$(git status --porcelain=v1 --untracked-files=all)"
if [[ -n "${FINAL_STATUS}" ]]; then
  echo "ERROR: Validation modified repository-visible files:"
  git status --short
  exit 1
fi

echo "Repository commit and working tree unchanged"

echo
echo "==> Result"
echo "Branch: ${START_BRANCH:-<detached>}"
echo "Commit: ${START_COMMIT}"
echo "Checks: PASS"
echo "Pack:   PASS"
echo "Import: PASS"
