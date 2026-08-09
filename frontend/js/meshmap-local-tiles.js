/**
 * Apply optional /meshmap/data/tileservers.local.json overrides onto mapInfo
 * after map_data.json is loaded. Survives poller JSON rsync when that file
 * is excluded from sync.
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

async function loadMapDataWithLocalTileOverrides() {
  const mapResp = await fetch('data/map_data.json', { cache: 'no-store' });
  if (!mapResp.ok) {
    throw new Error('Failed to load data/map_data.json: HTTP ' + mapResp.status);
  }
  const data = await mapResp.json();

  try {
    const localResp = await fetch('data/tileservers.local.json', { cache: 'no-store' });
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
