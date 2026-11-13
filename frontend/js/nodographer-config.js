/**
 * Nodographer frontend configuration and meshinfo data source.
 *
 * Reads config/nodographer.json (optional) relative to the frontend root:
 * {
 *   "meshinfo": { "baseUrl": "meshinfo/current/" },
 *   "map": { "title": ..., "centerLat": ..., "tileServers": {...}, ... }
 * }
 *
 * meshinfo.baseUrl is where map_data.json, node_report_data.json and the
 * nodes.kml/csv/json exports live. It may be relative to the frontend root
 * (local meshinfo data dir or an nginx proxy path) or absolute
 * (https://meshinfo-host/api/v1/). With no config the legacy "data/" is used,
 * so hosts that rsync poller output into frontend/data/ keep working.
 */
var NodographerConfig = (function () {
  var DEFAULT_BASE_URL = 'data/';
  var state = { config: {}, root: '', base: null };

  function rootUrl() {
    return new URL(state.root || './', window.location.href);
  }

  function baseUrl() {
    if (!state.base) {
      var meshinfo = state.config.meshinfo || {};
      var base = (typeof meshinfo.baseUrl === 'string' && meshinfo.baseUrl.trim()) || DEFAULT_BASE_URL;
      if (!base.endsWith('/')) {
        base += '/';
      }
      state.base = new URL(base, rootUrl());
    }
    return state.base;
  }

  /** URL of a meshinfo file, e.g. dataUrl('map_data.json'). */
  function dataUrl(name) {
    return new URL(name, baseUrl()).href;
  }

  /** URL relative to the frontend root (for files that stay with the frontend). */
  function frontendUrl(path) {
    return new URL(path, rootUrl()).href;
  }

  /**
   * Load config/nodographer.json. root is the path from the current page to
   * the frontend root ('' for index.html, '../' for node_report/). A missing
   * or invalid file falls back to defaults.
   */
  async function load(root) {
    state.root = root || '';
    state.base = null;
    try {
      var resp = await fetch(frontendUrl('config/nodographer.json'), { cache: 'no-store' });
      if (resp.ok) {
        var cfg = await resp.json();
        state.config = (cfg && typeof cfg === 'object') ? cfg : {};
      } else {
        state.config = {};
      }
    } catch (err) {
      console.warn('config/nodographer.json not loaded, using defaults:', err);
      state.config = {};
    }
    return state.config;
  }

  function map() {
    var m = state.config.map;
    return (m && typeof m === 'object') ? m : {};
  }

  return {
    load: load,
    dataUrl: dataUrl,
    frontendUrl: frontendUrl,
    map: map,
    get config() { return state.config; },
  };
})();
