const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dest = path.resolve(__dirname, '../docker/.env');
let source = fs.readFileSync(path.resolve(__dirname, '../docker/.env.example'), 'utf8');
for (const key of ['WHATSAPP_API_TOKEN', 'WHATSAPP_ADMIN_TOKEN', 'MCP_AUTH_TOKEN']) {
    source = source.replace(new RegExp('^' + key + '=$', 'm'), key + '=' + crypto.randomBytes(32).toString('hex'));
}
try {
    fs.writeFileSync(dest, source, { flag: 'wx', mode: 0o600 });
    console.log('Created docker/.env with distinct random tokens (mode 0600). Existing files are never overwritten.');
} catch (error) {
    console.error(error.code === 'EEXIST' ? 'docker/.env already exists; preserved without changes.' : 'Could not create docker/.env.');
    process.exitCode = 1;
}
