'use strict';
const fs = require('fs');
const readline = require('readline');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

// Preserve lines whose timestamp cannot be established. Input remains untouched.
async function pruneArchive(input, output, cutoff, { compressed = true } = {}) {
    if (!Number.isFinite(cutoff) || input === output) throw new Error('invalid arguments');
    const counts = { kept: 0, removed: 0, unknown: 0 };
    await pipeline(
        fs.createReadStream(input), ...(compressed ? [zlib.createGunzip()] : []),
        async function* (source) {
            const lines = readline.createInterface({ input: source, crlfDelay: Infinity });
            for await (const line of lines) {
                let value;
                try { value = JSON.parse(line).time; } catch (_) {}
                let timestamp = typeof value === 'number' ? value : Date.parse(value);
                if (typeof value === 'number' && value > 0 && value < 1e12) timestamp *= 1000;
                if (!Number.isFinite(timestamp)) { counts.unknown++; yield line + '\n'; }
                else if (timestamp >= cutoff) { counts.kept++; yield line + '\n'; }
                else counts.removed++;
            }
        },
        zlib.createGzip(), fs.createWriteStream(output, { flags: 'wx', mode: 0o600 })
    );
    return counts;
}
if (require.main === module || process.argv[1] === '-') {
    const [input, output, cutoff, format] = process.argv.slice(2);
    pruneArchive(input, output, Number(cutoff), { compressed: format !== 'plain' }).then(counts => console.log(JSON.stringify(counts)))
        .catch(() => { console.error('Archive processing failed; original remains unchanged.'); process.exitCode = 1; });
}
module.exports = { pruneArchive };
