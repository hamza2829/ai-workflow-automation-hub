#!/bin/sh
set -eu
n8n import:workflow --separate --input=/workflows
for workflow in errorRecovery001 dailyReport001 orderIntake001 failureProbe001; do
  n8n publish:workflow --id="$workflow"
done
exec n8n start
