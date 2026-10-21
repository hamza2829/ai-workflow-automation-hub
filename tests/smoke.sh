#!/bin/sh
set -eu
# First verify the HTTP transport with curl, then run stateful assertions.
curl --fail --silent http://localhost:3000/health
node tests/smoke.mjs
