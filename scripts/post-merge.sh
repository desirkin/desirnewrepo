#!/usr/bin/env bash
set -euo pipefail

# Reconcile the exact dependency tree after isolated task changes.
# This project has no compile step or automatic database migration command.
npm ci --ignore-scripts --no-audit --no-fund