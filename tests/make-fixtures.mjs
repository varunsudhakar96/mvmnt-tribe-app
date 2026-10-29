// Builds test fixtures: a fake camera feed showing a venue QR, and a made-up poster.
import QRCode from 'qrcode';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const DIR = process.argv[2] || 'tests/fixtures';
mkdirSync(DIR, { recursive: true });
export const TODAY_ID = '11111111-1111-4111-8111-111111111111';
export const TODAY_CODE = 'a1b2c3d4e5f6';
const link = `http://localhost:4173/#/run/${TODAY_ID}/checkin?c=${TODAY_CODE}`;

await QRCode.toFile(`${DIR}/qr.png`, link, { width: 480, margin: 4 });
await QRCode.toFile(`${DIR}/qr-other.png`, 'https://example.com/not-ours', { width: 480, margin: 4 });
for (const n of ['qr', 'qr-other']) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', `${DIR}/${n}.png`, '-t', '3',
    '-vf', 'pad=640:640:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p', '-r', '10', `${DIR}/${n}.y4m`]);
}
// Made-up poster (no real branding)
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'color=c=0x111111:s=1080x1350,drawbox=x=80:y=900:w=920:h=12:color=white@1:t=fill', '-frames:v', '1', `${DIR}/poster.jpg`]);
console.log('fixtures ready', link);
