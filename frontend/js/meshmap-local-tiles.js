/**
 * Load map_data.json from the configured meshinfo source and fill in map
 * presentation settings from config/nodographer.json.
 *
 * Legacy: optional /meshmap/data/tileservers.local.json overrides are still
 * applied last. Prefer "map.tileServers" in config/nodographer.json.
 *
 * Expected shape:
 * {
 *   "mapTileServers": { "name": "//host/{z}/{x}/{y}.png", ... },
 *   "defaultTileServer": "name",
 *   "priority": ["name1", "name2"],
 *   "replace": false
 * }
 *
 * replace=true  → replace mapTileServers entirely with local map
 * replace=false → merge (local keys override/add)
 * priority      → reorder layers; first existing becomes default if defaultTileServer omitted
 */
function applyLocalTileServerOverrides(mapInfo, overrides) {
  if (!mapInfo || !overrides || typeof overrides !== 'object') {
    return mapInfo;
  }

  const localServers = overrides.mapTileServers || overrides.tileServers;
  if (localServers && typeof localServers === 'object') {
    if (overrides.replace) {
      mapInfo.mapTileServers = Object.assign({}, localServers);
    } else {
      mapInfo.mapTileServers = Object.assign({}, mapInfo.mapTileServers || {}, localServers);
    }
  }

  if (!mapInfo.mapTileServers) {
    mapInfo.mapTileServers = {};
  }

  if (Array.isArray(overrides.priority) && overrides.priority.length) {
    const ordered = {};
    for (const name of overrides.priority) {
      if (Object.prototype.hasOwnProperty.call(mapInfo.mapTileServers, name)) {
        ordered[name] = mapInfo.mapTileServers[name];
      }
    }
    for (const [name, url] of Object.entries(mapInfo.mapTileServers)) {
      if (!Object.prototype.hasOwnProperty.call(ordered, name)) {
        ordered[name] = url;
      }
    }
    mapInfo.mapTileServers = ordered;
  }

  if (overrides.defaultTileServer) {
    mapInfo.defaultTileServer = overrides.defaultTileServer;
  } else if (Array.isArray(overrides.priority)) {
    for (const name of overrides.priority) {
      if (Object.prototype.hasOwnProperty.call(mapInfo.mapTileServers, name)) {
        mapInfo.defaultTileServer = name;
        break;
      }
    }
  }

  return mapInfo;
}

const MAP_DEFAULTS = {
  title: 'Nodographer Mesh Map',
  attribution: '',
  mapContact: '',
  kilometers: false,
  mapCenterCoords: [39.8, -98.6],
  mapInitialZoom: 4,
  reportBrowserTitle: 'Node Report',
  reportPageTitle: 'Node Report',
  mapTileServers: { 'inet.Street': '//{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' },
};

function isFiniteNumber(v) {
  return typeof v === 'number' && isFinite(v);
}

/**
 * Fill mapInfo presentation fields. Precedence: frontend config
 * (config/nodographer.json "map"), then legacy fields still present in
 * map_data.json from older pollers, then MAP_DEFAULTS.
 */
function applyFrontendMapConfig(mapInfo, cfg) {
  mapInfo = mapInfo || {};
  cfg = cfg || {};
  const pick = (cfgValue, key) => (cfgValue !== undefined && cfgValue !== null && cfgValue !== '')
    ? cfgValue
    : (mapInfo[key] !== undefined ? mapInfo[key] : MAP_DEFAULTS[key]);

  mapInfo.title = pick(cfg.title, 'title');
  mapInfo.attribution = pick(cfg.attribution, 'attribution');
  mapInfo.mapContact = pick(cfg.contact, 'mapContact');
  mapInfo.reportBrowserTitle = pick(cfg.reportBrowserTitle, 'reportBrowserTitle');
  mapInfo.reportPageTitle = pick(cfg.reportPageTitle, 'reportPageTitle');
  if (cfg.geocoderUrl) {
    mapInfo.geocoderUrl = cfg.geocoderUrl;
  }

  if (cfg.distanceUnits) {
    mapInfo.kilometers = cfg.distanceUnits === 'kilometers';
  } else if (typeof mapInfo.kilometers !== 'boolean') {
    mapInfo.kilometers = MAP_DEFAULTS.kilometers;
  }

  if (isFiniteNumber(cfg.centerLat) && isFiniteNumber(cfg.centerLon)) {
    mapInfo.mapCenterCoords = [cfg.centerLat, cfg.centerLon];
  } else if (!Array.isArray(mapInfo.mapCenterCoords)) {
    mapInfo.mapCenterCoords = MAP_DEFAULTS.mapCenterCoords.slice();
  }
  if (isFiniteNumber(cfg.initialZoom)) {
    mapInfo.mapInitialZoom = cfg.initialZoom;
  } else if (!isFiniteNumber(mapInfo.mapInitialZoom)) {
    mapInfo.mapInitialZoom = MAP_DEFAULTS.mapInitialZoom;
  }

  if (cfg.tileServers && typeof cfg.tileServers === 'object' && Object.keys(cfg.tileServers).length) {
    applyLocalTileServerOverrides(mapInfo, {
      mapTileServers: cfg.tileServers,
      priority: cfg.priority,
      defaultTileServer: cfg.defaultTileServer,
      replace: true,
    });
  } else if (!mapInfo.mapTileServers || !Object.keys(mapInfo.mapTileServers).length) {
    mapInfo.mapTileServers = Object.assign({}, MAP_DEFAULTS.mapTileServers);
  }
  if (!mapInfo.defaultTileServer || !(mapInfo.defaultTileServer in mapInfo.mapTileServers)) {
    mapInfo.defaultTileServer = Object.keys(mapInfo.mapTileServers)[0];
  }
  return mapInfo;
}

async function loadMapDataWithLocalTileOverrides() {
  await NodographerConfig.load('');
  const mapUrl = NodographerConfig.dataUrl('map_data.json');
  const mapResp = await fetch(mapUrl, { cache: 'no-store' });
  if (!mapResp.ok) {
    throw new Error('Failed to load ' + mapUrl + ': HTTP ' + mapResp.status);
  }
  const data = await mapResp.json();
  data.mapInfo = applyFrontendMapConfig(data.mapInfo, NodographerConfig.map());

  try {
    const localResp = await fetch(NodographerConfig.frontendUrl('data/tileservers.local.json'), { cache: 'no-store' });
    if (localResp.ok) {
      const overrides = await localResp.json();
      data.mapInfo = applyLocalTileServerOverrides(data.mapInfo, overrides);
      console.log('Applied local tileserver overrides from data/tileservers.local.json');
    }
  } catch (err) {
    console.warn('Local tileserver override skipped:', err);
  }

  return data;
}
