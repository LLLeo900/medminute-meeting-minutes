#!/usr/bin/env bash
# Restart the MedMinute site on port 7777: kills the process on the port and starts it again.
set -u
cd "$(dirname "$0")/.."
PORT="${1:-7777}"
for pid in $(netstat -ano | grep -E "LISTENING" | grep ":$PORT " | awk '{print $NF}' | sort -u); do
  echo "killing pid $pid"
  taskkill //PID "$pid" //F >/dev/null 2>&1
done
sleep 1
nohup node server.js > data/server.log 2>&1 &
sleep 2
curl -s "http://127.0.0.1:$PORT/api/health"; echo
