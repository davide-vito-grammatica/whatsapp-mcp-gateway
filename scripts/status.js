const token = process.env.WHATSAPP_API_TOKEN || '';
if (token.length < 32) { console.error('Configure WHATSAPP_API_TOKEN in docker/.env.'); process.exit(1); }
fetch('http://127.0.0.1:3000/status', { headers: { Authorization: 'Bearer ' + token },
    redirect: 'error', signal: AbortSignal.timeout(10000) }).then(async response => {
    if (!response.ok) throw Error('status_unavailable');
    const value = await response.json();
    console.log(JSON.stringify({ status: value.status, sessionHealth: value.sessionHealth || 'unknown' }));
}).catch(() => { console.error('Status unavailable; check loopback access, health and credentials.'); process.exitCode = 1; });
