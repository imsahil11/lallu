// Turns what a browser tells us (user-agent + client hints + screen size) into a readable
// device / os / browser. Used by the admin panel only, so the device list is loaded lazily.
//   describe(ua, hints, env) -> { device, os, browser, kind }      kind: phone | tablet | pc
//   hints: { platform, platformVersion, mobile, model, brands }   (navigator.userAgentData, Chromium only)
//   env  : { sw, sh, dpr, tp }                                    (screen size, pixel ratio, touch points)

let _db = null;
function db() {
  if (!_db) {
    try { _db = require('./data/devices.json'); }   // built by scripts/build-devices.js
    catch { _db = {}; }
  }
  return _db;
}

// ---------- android ----------

// tokens inside the UA parentheses that are not a model
const JUNK = /^(k|u|wv|mobile|tablet|linux|android[\d.\s]*|[a-z]{2,3}[-_][a-z]{2,4}|rv:.*)$/i;

function uaModel(ua) {
  const paren = (ua.match(/\(([^)]*Android[^)]*)\)/i) || [])[1];
  if (!paren) return null;
  const segs = paren.split(';').map(s => s.trim());
  const at   = segs.findIndex(s => /^Android\b/i.test(s));
  for (const raw of segs.slice(at + 1)) {
    const s = raw.replace(/\s+Build\/.*$/i, '').replace(/\s+MIUI\/.*$/i, '').trim();
    if (s && !JUNK.test(s)) return s;
  }
  return null;
}

// brand guess from the shape of an unknown model code
function brandOf(code) {
  if (/^SM-/i.test(code))                       return 'Samsung';
  if (/^RMX\d/i.test(code))                     return 'Realme';
  if (/^(V\d{4}|vivo\b)/i.test(code))           return 'Vivo';
  if (/^I\d{4}$/i.test(code))                   return 'iQOO';
  if (/^(CPH|PG|PH|PJ|PK)[A-Z]?\d{3,4}$/i.test(code)) return 'OPPO/OnePlus';
  if (/^(NE|LE|IV|KB|HD|GM|DN|EB|BE)\d{4}$/i.test(code)) return 'OnePlus';
  if (/^XT\d{4}/i.test(code))                   return 'Motorola';
  if (/^(M?\d{4,5}[A-Z0-9]{3,8}|M2\d{3}[A-Z0-9]+)$/i.test(code)) return 'Xiaomi';
  if (/^(X\d{4}|Infinix)/i.test(code))          return 'Infinix';
  if (/^(TECNO|[A-Z]{2}\d[a-z]?$)/i.test(code)) return 'Tecno';
  if (/^A\d{3}$/i.test(code))                   return 'Nothing';
  return null;
}

function androidName(model) {
  if (!model) return 'Android Phone';
  const hit = db()[model.toLowerCase()];
  if (hit) return hit;
  // already a readable name ("Pixel 8", "moto g54 5G", "Redmi Note 8 Pro", "vivo 1904")
  if (/^(pixel|moto|redmi|poco|galaxy|oneplus|nokia|infinix|tecno|realme|vivo|oppo|iqoo|nothing|honor|lava)\b/i.test(model)) {
    return /^pixel/i.test(model) ? `Google ${model}` : model.replace(/^[a-z]/, c => c.toUpperCase());
  }
  const brand = brandOf(model);
  return brand ? `${brand} ${model}` : model;
}

// ---------- apple ----------

// portrait logical screen size -> possible models. Apple never exposes the exact model to a web page.
const IPHONES = {
  '320x568': 'iPhone SE (1st gen)',
  '375x667': 'iPhone SE / 8',
  '414x736': 'iPhone 8 Plus',
  '375x812': 'iPhone X / XS / 11 Pro / 13 mini',
  '414x896': 'iPhone XR / 11 / 11 Pro Max',
  '390x844': 'iPhone 12 / 13 / 14 / 16e',
  '428x926': 'iPhone 13 Pro Max / 14 Plus',
  '393x852': 'iPhone 14 Pro / 15 / 16',
  '430x932': 'iPhone 15 Plus / 15 Pro Max / 16 Plus',
  '402x874': 'iPhone 16 Pro / 17 / 17 Pro',
  '440x956': 'iPhone 16 Pro Max / 17 Pro Max',
  '420x912': 'iPhone Air',
};

function iphoneName(env) {
  const w = Math.min(+env?.sw || 0, +env?.sh || 0), h = Math.max(+env?.sw || 0, +env?.sh || 0);
  return IPHONES[`${w}x${h}`] || 'iPhone';
}

function appleVersion(ua, re) {
  const os  = ((ua.match(re) || [])[1] || '').replace(/_/g, '.');
  // Safari 26+ freezes the OS version in the UA (stays 18.x); the real one is in "Version/26.0"
  const ver = (ua.match(/Version\/(\d+(?:\.\d+)?)/) || [])[1];
  if (ver && parseInt(ver, 10) >= 26 && !/CriOS|FxiOS|EdgiOS/.test(ua)) return ver;
  return os.split('.').slice(0, 2).join('.');
}

// ---------- browser ----------

function browserOf(ua, hints) {
  const brands = (hints?.brands || []).join(' ');
  if (/Instagram/i.test(ua))                 return 'Instagram (in-app)';
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua))    return 'Facebook (in-app)';
  if (/Snapchat/i.test(ua))                  return 'Snapchat (in-app)';
  if (/\bTwitter/i.test(ua))                 return 'X/Twitter (in-app)';
  if (/\bLine\//i.test(ua))                  return 'LINE (in-app)';
  if (/Brave/i.test(brands))                 return 'Brave';
  if (/Edg(A|iOS)?\//.test(ua))              return 'Edge';
  if (/OPR\/|OPT\/|OPiOS|Opera/i.test(ua))   return 'Opera';
  if (/SamsungBrowser/i.test(ua))            return 'Samsung Internet';
  if (/MiuiBrowser/i.test(ua))               return 'Mi Browser';
  if (/UCBrowser/i.test(ua))                 return 'UC Browser';
  if (/YaBrowser/i.test(ua))                 return 'Yandex';
  if (/DuckDuckGo/i.test(ua))                return 'DuckDuckGo';
  if (/Vivaldi/i.test(ua))                   return 'Vivaldi';
  if (/CriOS\//.test(ua))                    return 'Chrome';
  if (/FxiOS\/|Firefox\//.test(ua))          return 'Firefox';
  if (/;\s*wv\)/.test(ua))                   return 'In-app browser';
  if (/Chrome\//.test(ua))                   return 'Chrome';
  if (/Safari\//.test(ua))                   return 'Safari';
  return 'Unknown';
}

// ---------- main ----------

function describe(ua = '', hints = null, env = null) {
  ua = String(ua || '');
  const browser = browserOf(ua, hints);
  const touch   = +env?.tp > 1;

  if (/Android/i.test(ua) || hints?.platform === 'Android') {
    const fromUa = uaModel(ua);
    const model  = (hints?.model || '').trim() || fromUa;
    const hv     = hints?.platform === 'Android' ? parseInt(hints.platformVersion, 10) : NaN;
    const uv     = (ua.match(/Android (\d+)/i) || [])[1];
    // Chrome's reduced UA always says "Android 10; K" — that version is fake, only the hints know the real one
    const ver    = !isNaN(hv) && hv > 0 ? hv : (/Android 10; K\)/.test(ua) ? null : uv);
    const tablet = hints?.mobile === false || (!hints && !/Mobile/i.test(ua));
    return {
      device: model ? androidName(model) : (tablet ? 'Android Tablet' : 'Android Phone'),
      os: ver ? `Android ${ver}` : 'Android',
      browser, kind: tablet ? 'tablet' : 'phone',
    };
  }

  if (/iPhone|iPod/i.test(ua)) {
    const v = appleVersion(ua, /iPhone OS ([\d_]+)/i);
    return { device: iphoneName(env), os: v ? `iOS ${v}` : 'iOS', browser, kind: 'phone' };
  }

  // iPadOS pretends to be a Mac by default; a "Mac" with a touch screen is an iPad
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && touch)) {
    const v = /iPad/i.test(ua) ? appleVersion(ua, /OS ([\d_]+)/i) : ((ua.match(/Version\/(\d+(?:\.\d+)?)/) || [])[1] || '');
    return { device: 'iPad', os: v ? `iPadOS ${v}` : 'iPadOS', browser, kind: 'tablet' };
  }

  if (/Windows/i.test(ua)) {
    let os = 'Windows';
    if (/Windows NT 10/i.test(ua)) {
      const major = parseInt(hints?.platformVersion, 10);
      os = isNaN(major) ? 'Windows 10/11' : (major >= 13 ? 'Windows 11' : 'Windows 10');
    }
    return { device: 'Windows PC', os, browser, kind: 'pc' };
  }
  if (/Macintosh|Mac OS X/i.test(ua)) return { device: 'Mac', os: 'macOS', browser, kind: 'pc' };
  if (/CrOS/i.test(ua))               return { device: 'Chromebook', os: 'ChromeOS', browser, kind: 'pc' };
  if (/Linux/i.test(ua))              return { device: 'Linux PC', os: 'Linux', browser, kind: 'pc' };
  return { device: 'Unknown', os: 'Unknown', browser, kind: 'pc' };
}

module.exports = { describe };
