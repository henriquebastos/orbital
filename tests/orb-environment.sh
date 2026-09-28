#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Mock only the credential provider. Bash must quote and import real values.
(
  export OP_ENVIRONMENT_ID=fixture OP_SERVICE_ACCOUNT_TOKEN=fixture
  export ORBITAL_ENV_TEST=old
  expected=$'spaces \047quotes\047 "double" $HOME $(exit 97) `exit 98`\nsecond line\\'
  op() {
    [[ "$1 $2 $3 $4 $5" == 'run --no-masking --environment fixture --' ]] || return 1
    shift 5
    export ORBITAL_ENV_TEST="$expected" ORBITAL_ENV_EMPTY=''
    "$@"
  }
  source .agents/environment
  [[ "$ORBITAL_ENV_TEST" == "$expected" && "${ORBITAL_ENV_EMPTY+x}" == x && -z "$ORBITAL_ENV_EMPTY" ]]
  export expected
  bash --noprofile --norc -c '[[ "$ORBITAL_ENV_TEST" == "$expected" ]]'
)
(
  unset OP_ENVIRONMENT_ID OP_SERVICE_ACCOUNT_TOKEN
  op() { echo 'Unexpected provider call' >&2; return 99; }
  source .agents/environment
)
(
  export OP_ENVIRONMENT_ID=fixture
  unset OP_SERVICE_ACCOUNT_TOKEN
  if source .agents/environment 2>/dev/null; then
    echo 'Missing credentials did not fail' >&2
    exit 1
  fi
)
(
  export OP_ENVIRONMENT_ID=fixture OP_SERVICE_ACCOUNT_TOKEN=fixture
  export ORBITAL_ENV_TEST=unchanged
  op() { printf 'export ORBITAL_ENV_TEST=partial\n'; return 1; }
  if source .agents/environment 2>/dev/null; then
    echo 'Provider failure did not fail' >&2
    exit 1
  fi
  [[ "$ORBITAL_ENV_TEST" == unchanged ]]
)
echo 'Environment hook: 4 checks passed'
