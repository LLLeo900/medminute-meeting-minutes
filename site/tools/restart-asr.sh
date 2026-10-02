#!/usr/bin/env bash
# Restart the local ASR service (port 7778).
set -u
cd "$(dirname "$0")/.."
PORT="${1:-7778}"
for pid in $(netstat -ano | grep -E "LISTENING" | grep ":$PORT " | awk '{print $NF}' | sort -u); do
  echo "killing pid $pid"
  taskkill //PID "$pid" //F >/dev/null 2>&1
done
sleep 1
nohup python asr/service.py > data/asr.log 2>&1 &
sleep 10
curl -s "http://127.0.0.1:$PORT/health"; echo
