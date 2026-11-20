// Builds data/devices.json (model code -> marketing name) from Google Play's official device list.
// Run:  npm run devices     (re-run whenever new phones show up as raw codes in the admin panel)
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const SRC = 'https://storage.googleapis.com/play_public/supported_devices.csv';
const OUT = path.join(__dirname, '..', 'data', 'devices.json');

// brands worth keeping (lowercase "Retail Branding" values). pass --all to keep everything.
const BRANDS = new Set([
  'xiaomi', 'redmi', 'poco', 'samsung', 'realme', 'vivo', 'iqoo', 'oppo', 'oneplus', 'motorola',
  'nothing', 'cmf', 'infinix', 'tecno', 'itel', 'google', 'lava', 'honor', 'huawei', 'nokia', 'hmd',
  'asus', 'lenovo', 'micromax', 'sony', 'lg', 'lge', 'tcl', 'zte', 'nubia', 'meizu', 'black shark',
  'sharp', 'jio', 'lyf', 'reliance', 'acer', 'ai+', 'fairphone',
]);
const ALL = process.argv.includes('--all');

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// minimal CSV line parser (handles quoted fields with commas / doubled quotes)
function parseLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// "Samsung" + "Galaxy S23" -> "Samsung Galaxy S23";  "Xiaomi" + "POCO X6 Pro 5G" -> "POCO X6 Pro 5G"
const OWN_NAME = /^(poco|redmi|iqoo|pixel|nothing|cmf|moto|motorola|oneplus|nord|realme|narzo|infinix|tecno|itel|honor|nokia)\b/i;
function fullName(brand, name) {
  if (!brand) return name;
  const b = brand.toLowerCase(), n = name.toLowerCase();
  if (n.includes(b) || OWN_NAME.test(name)) return name;
  return `${brand} ${name}`;
}

(async () => {
  const buf  = await download(SRC);
  // the file is UTF-16LE with a BOM
  const text = (buf[0] === 0xff && buf[1] === 0xfe) ? buf.toString('utf16le').slice(1) : buf.toString('utf8');
  const rows = text.split(/\r?\n/).slice(1);

  const map = {};
  let kept = 0;
  for (const line of rows) {
    if (!line.trim()) continue;
    const [brand, marketing, , model] = parseLine(line);
    if (!model || !marketing) continue;
    if (!ALL && !BRANDS.has((brand || '').toLowerCase())) continue;
    if (marketing.toLowerCase() === model.toLowerCase()) continue;   // no real name, the code itself is the fallback anyway
    if (/^(vivo\s+)?[A-Z]{0,3}\d{3,}[A-Z0-9]*$/i.test(marketing)) continue;   // "marketing name" is just another code (common for vivo)
    const key = model.toLowerCase();
    if (map[key]) continue;                                          // first row wins
    map[key] = fullName(brand, marketing);
    kept++;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(map));
  console.log(`devices.json: ${kept} models, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB (source rows: ${rows.length})`);
})().catch(e => { console.error('build-devices failed:', e.message); process.exit(1); });
