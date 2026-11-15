#!/bin/sh
# Double-click on a Mac (or run ./start.command on Linux) to start Paper Desk.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Paper Desk needs Node.js. Install the LTS version from https://nodejs.org and run this again."
  exit 1
fi
exec node server.js --open
