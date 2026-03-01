const express = require('express');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
  return JSON.parse(raw);
}

async function fetchXML(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${url} (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (url.endsWith('.gz') || res.headers.get('content-encoding') === 'gzip') {
    return zlib.gunzipSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

function parseXMLTV(xmlStr) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'channel' || name === 'programme' || name === 'display-name' || name === 'icon',
  });
  const parsed = parser.parse(xmlStr);
  const tv = parsed.tv || {};
  return {
    channels: tv.channel || [],
    programmes: tv.programme || [],
  };
}

function applyHDPlusTransform(epg) {
  const channelIdMap = new Map();

  const channels = epg.channels.map((ch) => {
    const id = ch['@_id'] || '';
    if (id.includes('.HD.')) {
      const newId = id.replace('.HD.', '.HD+.');
      channelIdMap.set(id, newId);
      const newCh = { ...ch, '@_id': newId };
      if (newCh['display-name']) {
        newCh['display-name'] = newCh['display-name'].map((dn) => {
          if (typeof dn === 'string') {
            return dn.replace(/ HD$/, ' HD+').replace(/ HD /, ' HD+ ');
          }
          if (dn['#text']) {
            return {
              ...dn,
              '#text': dn['#text'].replace(/ HD$/, ' HD+').replace(/ HD /, ' HD+ '),
            };
          }
          return dn;
        });
      }
      return newCh;
    }
    return ch;
  });

  const programmes = epg.programmes.map((prog) => {
    const chRef = prog['@_channel'] || '';
    if (channelIdMap.has(chRef)) {
      return { ...prog, '@_channel': channelIdMap.get(chRef) };
    }
    return prog;
  });

  return { channels, programmes };
}

function mergeEPGs(epgList) {
  const seenChannels = new Set();
  const allChannels = [];
  const allProgrammes = [];

  for (const epg of epgList) {
    for (const ch of epg.channels) {
      const id = ch['@_id'];
      if (!seenChannels.has(id)) {
        seenChannels.add(id);
        allChannels.push(ch);
      }
    }
    allProgrammes.push(...epg.programmes);
  }

  return { channels: allChannels, programmes: allProgrammes };
}

function buildXMLTV(merged) {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true,
    suppressEmptyNode: true,
  });

  const tvObj = {
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    tv: {
      '@_generator-info-name': 'epg-merger',
      channel: merged.channels,
      programme: merged.programmes,
    },
  };

  return builder.build(tvObj);
}

async function generateEPG() {
  const config = loadConfig();
  const enabledSources = config.sources.filter((s) => s.enabled);

  if (enabledSources.length === 0) {
    throw new Error('No enabled sources in config.json');
  }

  console.log(`Fetching ${enabledSources.length} source(s)...`);
  const fetchResults = await Promise.allSettled(
    enabledSources.map(async (source) => {
      console.log(`  Fetching: ${source.name} (${source.url})`);
      const xml = await fetchXML(source.url);
      console.log(`  Done: ${source.name} (${(xml.length / 1024 / 1024).toFixed(1)}MB)`);
      let epg = parseXMLTV(xml);
      if (source.convertToHDPlus) {
        console.log(`  Applying HD+ transform: ${source.name}`);
        epg = applyHDPlusTransform(epg);
      }
      return epg;
    })
  );

  const epgList = [];
  for (const result of fetchResults) {
    if (result.status === 'fulfilled') {
      epgList.push(result.value);
    } else {
      console.error('Source fetch failed:', result.reason.message);
    }
  }

  if (epgList.length === 0) {
    throw new Error('All sources failed to fetch');
  }

  console.log('Merging EPGs...');
  const merged = mergeEPGs(epgList);
  console.log(`Result: ${merged.channels.length} channels, ${merged.programmes.length} programmes`);

  const xmlStr = buildXMLTV(merged);
  return xmlStr;
}

app.get('/epg.xml', async (req, res) => {
  try {
    const xml = await generateEPG();
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    console.error('Error generating EPG:', err.message);
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.get('/epg.xml.gz', async (req, res) => {
  try {
    const xml = await generateEPG();
    const gzipped = zlib.gzipSync(Buffer.from(xml, 'utf8'));
    res.set('Content-Type', 'application/gzip');
    res.set('Content-Disposition', 'attachment; filename="epg.xml.gz"');
    res.send(gzipped);
  } catch (err) {
    console.error('Error generating EPG:', err.message);
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.get('/', (req, res) => {
  res.json({
    service: 'epg-merger',
    endpoints: ['/epg.xml', '/epg.xml.gz'],
    config: loadConfig(),
  });
});

app.listen(PORT, () => {
  console.log(`EPG Merger running on port ${PORT}`);
});
