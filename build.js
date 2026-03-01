const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
}

async function fetchXML(url) {
  console.log(`  Fetching: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${url} (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (url.endsWith('.gz') || res.headers.get('content-encoding') === 'gzip') {
    return zlib.gunzipSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'channel' || name === 'programme' || name === 'display-name' || name === 'icon',
});

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  suppressEmptyNode: true,
});

function parseXMLTV(xmlStr) {
  const parsed = xmlParser.parse(xmlStr);
  const tv = parsed.tv || {};
  return { channels: tv.channel || [], programmes: tv.programme || [] };
}

function applyHDPlusTransform(epg) {
  const channels = epg.channels.map((ch) => {
    const id = ch['@_id'] || '';
    if (id.includes('.HD.')) {
      const newCh = { ...ch };
      if (newCh['display-name']) {
        newCh['display-name'] = newCh['display-name'].map((dn) => {
          if (typeof dn === 'string') return dn.replace(/ HD$/, ' HD+').replace(/ HD /, ' HD+ ');
          if (dn['#text']) return { ...dn, '#text': dn['#text'].replace(/ HD$/, ' HD+').replace(/ HD /, ' HD+ ') };
          return dn;
        });
      }
      return newCh;
    }
    return ch;
  });
  return { channels, programmes: epg.programmes };
}

async function build() {
  const config = loadConfig();
  const sources = config.sources.filter((s) => s.enabled);
  console.log(`Building EPG from ${sources.length} source(s)...`);

  const seenChannels = new Set();
  const allChannels = [];
  const allProgrammes = [];

  for (const source of sources) {
    try {
      const xml = await fetchXML(source.url);
      console.log(`  Fetched: ${source.name} (${(xml.length / 1024 / 1024).toFixed(1)}MB)`);

      let epg = parseXMLTV(xml);
      if (source.convertToHDPlus) epg = applyHDPlusTransform(epg);

      for (const ch of epg.channels) {
        if (!seenChannels.has(ch['@_id'])) {
          seenChannels.add(ch['@_id']);
          allChannels.push(ch);
        }
      }
      allProgrammes.push(...epg.programmes);
      console.log(`  Done: ${source.name} (${epg.channels.length} ch, ${epg.programmes.length} prog)`);
    } catch (err) {
      console.error(`  Failed: ${source.name}: ${err.message}`);
    }
  }

  if (allChannels.length === 0) {
    console.error('No channels found, aborting.');
    process.exit(1);
  }

  console.log(`Merged: ${allChannels.length} channels, ${allProgrammes.length} programmes`);

  const tvObj = {
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    tv: {
      '@_generator-info-name': 'epg-merger',
      channel: allChannels,
      programme: allProgrammes,
    },
  };

  const xmlStr = xmlBuilder.build(tvObj);
  const gzipped = zlib.gzipSync(Buffer.from(xmlStr, 'utf8'));

  fs.writeFileSync(path.join(__dirname, 'epg.xml.gz'), gzipped);

  const xmlMB = (xmlStr.length / 1024 / 1024).toFixed(1);
  const gzKB = (gzipped.length / 1024).toFixed(0);
  console.log(`Output: epg.xml.gz (${xmlMB}MB xml -> ${gzKB}KB gzipped)`);
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
