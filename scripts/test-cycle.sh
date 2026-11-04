#!/bin/bash
# One-shot dev-server test cycle: starts `bun run dev`, waits for readiness,
# runs the passed command(s), then the server dies with this script.
# (Background processes are reaped between tool calls, so the server must
# live and die within a single invocation.)
cd /home/z/my-project/neutralwire || exit 1

echo "[test-cycle] starting dev server..."
rm -rf .next
nohup bun run dev > /tmp/nw-dev.log 2>&1 &
DEV_PID=$!

# Wait for the server to be ready (up to 60s)
for i in $(seq 1 60); do
  if curl -s -o /dev/null --max-time 2 http://localhost:3000/api/flags 2>/dev/null; then
    # /api/flags may hang on Firebase — a fast hang response still means the
    # HTTP server is up; check the log for the ready line instead.
    :
  fi
  if grep -q "Ready in" /tmp/nw-dev.log 2>/dev/null; then
    echo "[test-cycle] server ready after ${i}s"
    break
  fi
  sleep 1
done

# Execute the payload commands
eval "$@"
EXIT=$?

kill $DEV_PID 2>/dev/null
echo "[test-cycle] done (exit $EXIT)"
exit $EXIT
