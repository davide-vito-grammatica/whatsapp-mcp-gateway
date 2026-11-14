#!/usr/bin/env bash
set -euo pipefail
fixture=$(mktemp -d)
cleanup() { docker rm -f whatsapp-ci-proxy >/dev/null 2>&1 || true; sudo rm -rf -- "$fixture"; }
trap cleanup EXIT
mkdir -p "$fixture/data/auth" "$fixture/data/dead-letter-queue" "$fixture/config"
printf '%s\n' '{}' > "$fixture/data/auth/creds.json"
printf '%s\n' '{"status":"pending","payload":{"message":"synthetic legacy sentinel"}}' > "$fixture/data/dead-letter-queue/sentinel.json"
chmod 600 "$fixture/data/auth/creds.json"
sudo chown -R 1000:1000 "$fixture/data/auth"
before=$(sudo sha256sum "$fixture/data/auth/creds.json" | cut -d ' ' -f 1)
legacy_before=$(sha256sum "$fixture/data/dead-letter-queue/sentinel.json" | cut -d ' ' -f 1)
auth_metadata=$(stat -c '%u:%g:%a' "$fixture/data/auth/creds.json")
export WHATSAPP_API_TOKEN="synthetic-backend-$(printf '%040d' 0)"
export WHATSAPP_ADMIN_TOKEN="synthetic-admin-$(printf '%040d' 0)"
docker run -d --name whatsapp-ci-proxy --network none \
  --health-cmd "wget --quiet --tries=1 --spider http://127.0.0.1:3000/health" --health-interval 2s --health-timeout 3s --health-retries 30 \
  -e WHATSAPP_API_TOKEN -e WHATSAPP_ADMIN_TOKEN \
  -v "$fixture/data:/app/data" -v "$fixture/config:/app/config" whatsapp-proxy-ci >/dev/null
ready() {
  for attempt in $(seq 1 30); do
    if [ "$(docker inspect whatsapp-ci-proxy --format '{{.State.Health.Status}}')" = healthy ] && docker exec whatsapp-ci-proxy node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then return; fi
    sleep 2
  done
  return 1
}
ready
# A fresh config volume must receive disabled, destination-free defaults.
docker exec whatsapp-ci-proxy node -e "const c=require('ini').parse(require('fs').readFileSync('/app/config/config.ini','utf8'));if(c.keepalive.enabled!==false || c.keepalive.group_id)process.exit(1)"
# No authorized write route is called. Denied malformed sends must not touch the queue.
docker exec -i whatsapp-ci-proxy node - <<'JS'
(async () => {
 const base='http://127.0.0.1:3000';
 const health=await (await fetch(base+'/health')).json();
 if (JSON.stringify(health)!=='{"status":"ok"}') throw Error('health_contract');
 if ((await fetch(base+'/status')).status!==401) throw Error('anonymous_status');
 if ((await fetch(base+'/send-message',{method:'POST',headers:{'Content-Type':'application/json'},body:'{SYNTHETIC'})).status!==401) throw Error('anonymous_send');
 const api={Authorization:'Bearer '+process.env.WHATSAPP_API_TOKEN};
 if (!(await fetch(base+'/status',{headers:api})).ok) throw Error('authenticated_status');
 if ((await fetch(base+'/session/logout',{method:'POST',headers:api})).status!==401) throw Error('api_admin');
})().catch(e=>{console.error(e.message);process.exit(1)});
JS
docker restart whatsapp-ci-proxy >/dev/null
ready
test "$(sudo sha256sum "$fixture/data/auth/creds.json" | cut -d ' ' -f 1)" = "$before"
test "$(stat -c '%u:%g:%a' "$fixture/data/auth/creds.json")" = "$auth_metadata"
test "$(sha256sum "$fixture/data/dead-letter-queue/sentinel.json" | cut -d ' ' -f 1)" = "$legacy_before"
docker stop --time 15 whatsapp-ci-proxy >/dev/null
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=1777 --cap-drop ALL --security-opt no-new-privileges whatsapp-mcp-ci python /app/test_mcp.py
