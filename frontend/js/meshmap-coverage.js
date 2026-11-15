/**
 * Meshmap (== Nodographer frontend) radio primary coverage overlay.
 *
 * Show modes: Off (default), Band, Node, Bandwidth. Draws cones/circles from
 * antenna pattern when known (Node mode always draws as omni if unknown),
 * colors by the selected mode, and places matching colored node icons.
 */
(function (window) {
  var RF_BANDS = ['900', '2ghz', '3ghz', '5ghz'];
  var BAND_LABELS = {
    '900': '900 MHz',
    '2ghz': '2.4 GHz',
    '3ghz': '3.4 GHz',
    '5ghz': '5.8 GHz'
  };
  var BAND_COLORS = {
    '900': '#c2185b',
    '2ghz': '#7b1fa2',
    '3ghz': '#1976d2',
    '5ghz': '#f9a825'
  };
  var BW_COLORS = {
    '1': '#e41a1c',
    '4': '#377eb8',
    '5': '#4daf4a',
    '10': '#984ea3',
    '20': '#ff7f00'
  };
  var MODES = ['off', 'band', 'node', 'bandwidth'];
  var LAYER_NAME = 'Radio Coverage';
  var SESSION_KEY = 'coverage';
  var DEFAULT_RANGE = 20;
  var DEFAULT_MODE = 'off';
  var MIN_RANGE = 1;
  var MAX_RANGE = 100;
  var NODE_RESULT_LIMIT = 12;
  var ARC_STEP_DEG = 2;
  var EARTH_RADIUS_M = 6371000;

  var UNKNOWN_STYLE = {
    color: '#bbbbbb',
    weight: 1.5,
    dashArray: '4,6',
    fillColor: '#bbbbbb',
    fillOpacity: 0.3,
    interactive: false
  };

  var COVERAGE_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 2a8 8 0 0 1 7.75 6H12V4zm0 16a8 8 0 0 1-7.75-6H12v6zm2-8h5.75A8 8 0 0 1 14 19.75V12z"/>' +
    '</svg>';

  var coverageLayer = L.layerGroup();
  var map = null;
  var mapInfo = null;
  var rfNodes = [];
  var bandwidthOptions = [];
  var bandOptions = [];
  var channelOptions = [];
  var nodeNames = [];
  var state = {
    mode: DEFAULT_MODE,
    hideUnknown: false,
    names: [],
    colors: {},
    bandwidths: [],
    bands: [],
    channels: [],
    range: DEFAULT_RANGE
  };
  var control = null;
  var syncingLayer = false;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function parseBw(v) {
    if (v === null || v === undefined || v === '' || v === 'None') return null;
    var n = parseFloat(String(v).replace(/[^\d.]/g, ''));
    return isFinite(n) && n > 0 ? n : null;
  }

  function hasKnownAntenna(node) {
    var desc = node.antDesc;
    var beam = num(node.antBeam);
    return !!(desc && desc !== 'Not Available' && beam !== null && beam > 0);
  }

  function rangeMeters(range) {
    if (mapInfo && mapInfo.kilometers) {
      return range * 1000;
    }
    return range * 1609.344;
  }

  function rangeUnitLabel() {
    return mapInfo && mapInfo.kilometers ? 'km' : 'mi';
  }

  function destinationPoint(lat, lon, bearingDeg, distanceM) {
    var δ = distanceM / EARTH_RADIUS_M;
    var θ = (bearingDeg * Math.PI) / 180;
    var φ1 = (lat * Math.PI) / 180;
    var λ1 = (lon * Math.PI) / 180;
    var sinφ1 = Math.sin(φ1);
    var cosφ1 = Math.cos(φ1);
    var sinδ = Math.sin(δ);
    var cosδ = Math.cos(δ);
    var φ2 = Math.asin(sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ));
    var λ2 =
      λ1 +
      Math.atan2(Math.sin(θ) * sinδ * cosφ1, cosδ - sinφ1 * Math.sin(φ2));
    return [ (φ2 * 180) / Math.PI, ((((λ2 * 180) / Math.PI) + 540) % 360) - 180 ];
  }

  function coneLatLngs(lat, lon, azimuth, beam, distanceM) {
    var half = beam / 2;
    var start = azimuth - half;
    var end = azimuth + half;
    var pts = [ [lat, lon] ];
    var steps = Math.max(1, Math.ceil(beam / ARC_STEP_DEG));
    for (var i = 0; i <= steps; i++) {
      var bearing = start + ((end - start) * i) / steps;
      pts.push(destinationPoint(lat, lon, bearing, distanceM));
    }
    pts.push([lat, lon]);
    return pts;
  }

  function fallbackFreqMhz(bandKey, channel) {
    var ch = num(channel);
    if (ch === null) return null;
    if (bandKey === '2ghz') return 2407 + 5 * ch;
    if (bandKey === '5ghz') return 5000 + 5 * ch;
    return null;
  }

  /**
   * Prefer measured frequency over the map's band bucket. HaLow / 900 MHz
   * radios are often filed under 2ghz/5ghz because channel numbers collide
   * with Wi-Fi channel tables.
   */
  function bandFromFreq(freq, fallbackBandKey) {
    var f = num(freq);
    if (f !== null && f > 0) {
      if (f >= 800 && f < 1000) return '900';
      if (f >= 2300 && f < 2700) return '2ghz';
      if (f >= 3300 && f < 3600) return '3ghz';
      if (f >= 4900 && f < 6200) return '5ghz';
    }
    return fallbackBandKey || '5ghz';
  }

  function channelCenterMhz(node) {
    var f = num(node.freq);
    if (f !== null && f > 0) return f;
    return fallbackFreqMhz(node._bandKey, node.channel);
  }

  function channelRangeLabel(node) {
    var ch = node.channel;
    if (ch === null || ch === undefined || ch === '' || ch === 'None') {
      return 'Unknown';
    }
    var center = channelCenterMhz(node);
    var bw = parseBw(node.chanbw);
    if (center === null || bw === null) {
      return String(ch);
    }
    var half = bw / 2;
    var lo = Math.round(center - half);
    var hi = Math.round(center + half);
    return ch + ' (' + lo + '-' + hi + ' MHz)';
  }

  function channelKey(node) {
    return [
      node._bandKey,
      String(node.channel),
      String(node.chanbw || '')
    ].join('|');
  }

  function hashString(s) {
    var h = 2166136261;
    var str = String(s || '');
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0;
    var g = 0;
    var b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    function hex(n) {
      var v = Math.round((n + m) * 255);
      var s2 = v.toString(16);
      return s2.length === 1 ? '0' + s2 : s2;
    }
    return '#' + hex(r) + hex(g) + hex(b);
  }

  function colorForNode(name) {
    var hue = hashString(String(name).toLowerCase()) % 360;
    return hslToHex(hue, 72, 42);
  }

  function colorForBandwidth(chanbw) {
    var key = String(chanbw);
    if (BW_COLORS[key]) return BW_COLORS[key];
    var mhz = parseBw(chanbw);
    if (mhz !== null && BW_COLORS[String(mhz)]) return BW_COLORS[String(mhz)];
    var hue = (hashString(key) % 300) + 20;
    return hslToHex(hue, 70, 42);
  }

  function colorForBand(bandKey) {
    return BAND_COLORS[bandKey] || '#888888';
  }

  function normalizeHexColor(value) {
    var s = String(value || '').trim();
    var m = s.match(/^#?([0-9a-f]{6})$/i);
    if (m) return '#' + m[1].toLowerCase();
    m = s.match(/^#?([0-9a-f]{3})$/i);
    if (m) {
      var t = m[1].toLowerCase();
      return '#' + t.charAt(0) + t.charAt(0) + t.charAt(1) + t.charAt(1) + t.charAt(2) + t.charAt(2);
    }
    return null;
  }

  function colorKey(name) {
    return String(name || '').toLowerCase();
  }

  function getCustomColor(name) {
    var key = colorKey(name);
    var hex = normalizeHexColor(state.colors && state.colors[key]);
    return hex;
  }

  function ensureNodeColor(name) {
    var key = colorKey(name);
    if (!state.colors) state.colors = {};
    var existing = normalizeHexColor(state.colors[key]);
    if (existing) {
      state.colors[key] = existing;
      return existing;
    }
    var generated = colorForNode(name);
    state.colors[key] = generated;
    return generated;
  }

  function removeNodeColor(name) {
    if (!state.colors) return;
    delete state.colors[colorKey(name)];
  }

  function coverageColor(node) {
    // Name-filter chips carry per-node color overrides
    if (state.names.length) {
      var custom = getCustomColor(node.node);
      if (custom) return custom;
    }
    if (state.mode === 'node') return colorForNode(node.node);
    if (state.mode === 'bandwidth') return colorForBandwidth(node.chanbw);
    return colorForBand(node._bandKey);
  }

  function collectRfNodes(allDevices) {
    var list = [];
    var seen = {};
    RF_BANDS.forEach(function (bandKey) {
      var arr = (allDevices && allDevices[bandKey]) || [];
      for (var i = 0; i < arr.length; i++) {
        var d = arr[i];
        if (!d || !d.node) continue;
        var lat = num(d.lat);
        var lon = num(d.lon);
        if (lat === null || lon === null) continue;
        var key = String(d.node).toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        list.push({
          node: String(d.node),
          lat: lat,
          lon: lon,
          channel: d.channel,
          chanbw: d.chanbw,
          freq: d.freq,
          antDesc: d.antDesc,
          antBeam: d.antBeam,
          antAzimuth: d.antAzimuth,
          antGain: d.antGain,
          _bandKey: bandFromFreq(d.freq, bandKey),
          _device: d
        });
      }
    });
    list.sort(function (a, b) {
      return a.node.localeCompare(b.node);
    });
    return list;
  }

  function buildOptionLists(nodes) {
    var bwMap = {};
    var bandMap = {};
    var chMap = {};
    var names = [];

    nodes.forEach(function (n) {
      names.push(n.node);
      var bw = parseBw(n.chanbw);
      if (bw !== null) {
        var bwKey = String(n.chanbw);
        if (!bwMap[bwKey]) {
          bwMap[bwKey] = { value: bwKey, mhz: bw, label: bw + ' MHz' };
        }
      }
      if (!bandMap[n._bandKey]) {
        bandMap[n._bandKey] = {
          value: n._bandKey,
          label: BAND_LABELS[n._bandKey] || n._bandKey
        };
      }
      var ck = channelKey(n);
      if (!chMap[ck] && n.channel !== null && n.channel !== undefined && n.channel !== '' && n.channel !== 'None') {
        chMap[ck] = {
          value: ck,
          bandKey: n._bandKey,
          channel: String(n.channel),
          chanbw: String(n.chanbw || ''),
          label: channelRangeLabel(n)
        };
      }
    });

    bandwidthOptions = Object.keys(bwMap)
      .map(function (k) { return bwMap[k]; })
      .sort(function (a, b) { return a.mhz - b.mhz; });

    bandOptions = RF_BANDS.filter(function (k) { return bandMap[k]; }).map(function (k) {
      return bandMap[k];
    });

    channelOptions = Object.keys(chMap)
      .map(function (k) { return chMap[k]; })
      .sort(function (a, b) {
        var bi = RF_BANDS.indexOf(a.bandKey) - RF_BANDS.indexOf(b.bandKey);
        if (bi !== 0) return bi;
        var ca = num(a.channel);
        var cb = num(b.channel);
        if (ca !== null && cb !== null && ca !== cb) return ca - cb;
        return a.label.localeCompare(b.label);
      });

    nodeNames = names;
  }

  function normalizeMode(mode) {
    return MODES.indexOf(mode) !== -1 ? mode : DEFAULT_MODE;
  }

  function loadState() {
    state = {
      mode: DEFAULT_MODE,
      hideUnknown: false,
      names: [],
      colors: {},
      bandwidths: [],
      bands: [],
      channels: [],
      range: DEFAULT_RANGE
    };
    if (!window.MeshmapSession) return;
    var s = MeshmapSession.read();
    var c = s && s[SESSION_KEY];
    if (!c || typeof c !== 'object') return;
    if (c.mode) state.mode = normalizeMode(c.mode);
    if (typeof c.hideUnknown === 'boolean') state.hideUnknown = c.hideUnknown;
    if (Array.isArray(c.names)) state.names = c.names.slice();
    if (c.colors && typeof c.colors === 'object') {
      Object.keys(c.colors).forEach(function (k) {
        var hex = normalizeHexColor(c.colors[k]);
        if (hex) state.colors[colorKey(k)] = hex;
      });
    }
    if (Array.isArray(c.bandwidths)) state.bandwidths = c.bandwidths.slice();
    if (Array.isArray(c.bands)) state.bands = c.bands.slice();
    if (Array.isArray(c.channels)) state.channels = c.channels.slice();
    var r = num(c.range);
    if (r !== null) {
      state.range = Math.max(MIN_RANGE, Math.min(MAX_RANGE, Math.round(r)));
    }
    // Ensure every filtered name has a picker color
    state.names.forEach(function (name) { ensureNodeColor(name); });
  }

  function saveState() {
    if (!window.MeshmapSession) return;
    var patch = {};
    patch[SESSION_KEY] = {
      mode: state.mode,
      hideUnknown: !!state.hideUnknown,
      names: state.names.slice(),
      colors: (function () {
        var out = {};
        var src = state.colors || {};
        Object.keys(src).forEach(function (k) { out[k] = src[k]; });
        return out;
      })(),
      bandwidths: state.bandwidths.slice(),
      bands: state.bands.slice(),
      channels: state.channels.slice(),
      range: state.range
    };
    MeshmapSession.write(patch);
  }

  function nodeMatches(node) {
    if (state.names.length) {
      var lower = node.node.toLowerCase();
      var hit = false;
      for (var i = 0; i < state.names.length; i++) {
        if (String(state.names[i]).toLowerCase() === lower) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }
    if (state.bandwidths.length) {
      if (state.bandwidths.indexOf(String(node.chanbw)) === -1) return false;
    }
    if (state.bands.length) {
      if (state.bands.indexOf(node._bandKey) === -1) return false;
    }
    if (state.channels.length) {
      if (state.channels.indexOf(channelKey(node)) === -1) return false;
    }
    return true;
  }

  function classify(node) {
    if (!hasKnownAntenna(node)) return 'unknown';
    var beam = num(node.antBeam);
    if (beam >= 360) return 'omni';
    var az = num(node.antAzimuth);
    if (az === null) return 'unknown';
    return 'directional';
  }

  function findRfNodeByName(name) {
    var lower = String(name || '').toLowerCase();
    for (var i = 0; i < rfNodes.length; i++) {
      if (rfNodes[i].node.toLowerCase() === lower) return rfNodes[i];
    }
    return null;
  }

  /** Unknown pattern is skipped when Hide Unknown is on. */
  function isCoverageHidden(node) {
    return !!(state.hideUnknown && classify(node) === 'unknown');
  }

  function isNameChipDisabled(name) {
    if (!state.hideUnknown) return false;
    var node = findRfNodeByName(name);
    return !!(node && classify(node) === 'unknown');
  }

  function knownStyle(color) {
    return {
      color: color,
      weight: 1,
      fillColor: color,
      fillOpacity: 0.3,
      interactive: false
    };
  }

  function circleOptions(base, meters) {
    return {
      radius: meters,
      color: base.color,
      weight: base.weight,
      dashArray: base.dashArray,
      fill: base.fill !== false,
      fillColor: base.fillColor,
      fillOpacity: base.fillOpacity,
      interactive: false
    };
  }

  function makeShape(node, meters, color) {
    var kind = classify(node);
    var useUnknownGrey = kind === 'unknown' && state.mode !== 'node';

    if (useUnknownGrey) {
      return L.circle([node.lat, node.lon], circleOptions(UNKNOWN_STYLE, meters));
    }

    var style = knownStyle(color);
    // Node mode: unknown antenna still draws as assumed omni in the node color
    if (kind === 'directional') {
      var az = num(node.antAzimuth);
      var beam = num(node.antBeam);
      return L.polygon(coneLatLngs(node.lat, node.lon, az, beam, meters), style);
    }
    return L.circle([node.lat, node.lon], circleOptions(style, meters));
  }

  function makeMarker(node, color) {
    var iconColor = (classify(node) === 'unknown' && state.mode !== 'node')
      ? '#bbbbbb'
      : color;
    var icon = L.divIcon({
      className: 'meshmap-coverage-node-icon',
      html: '<span class="meshmap-coverage-node-dot" style="background-color:' +
        iconColor + ';border-color:' + iconColor + '"></span>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      popupAnchor: [0, -8]
    });
    var marker = L.marker([node.lat, node.lon], {
      icon: icon,
      title: node.node,
      zIndexOffset: 1000
    });
    if (typeof createNodePopup === 'function' && node._device) {
      var opts = typeof meshmapBindPopupOptions === 'function'
        ? meshmapBindPopupOptions()
        : { maxWidth: 350 };
      marker.bindPopup(createNodePopup(node._device), opts);
    }
    return marker;
  }

  function redraw() {
    coverageLayer.clearLayers();
    var counts = { total: 0, directional: 0, omni: 0, unknown: 0, hidden: 0 };
    rfNodes.forEach(function (node) {
      if (!nodeMatches(node)) return;
      var kind = classify(node);
      if (isCoverageHidden(node)) {
        counts.hidden++;
        return;
      }
      counts.total++;
      counts[kind]++;
    });

    if (state.mode !== 'off') {
      var meters = rangeMeters(state.range);
      rfNodes.forEach(function (node) {
        if (!nodeMatches(node)) return;
        if (isCoverageHidden(node)) return;
        var color = coverageColor(node);
        coverageLayer.addLayer(makeShape(node, meters, color));
        coverageLayer.addLayer(makeMarker(node, color));
      });
    }

    if (control) {
      if (typeof control.updateStatus === 'function') control.updateStatus(counts);
      if (typeof control.updateLegend === 'function') control.updateLegend();
      if (typeof control.setModeSelect === 'function') control.setModeSelect(state.mode);
      if (typeof control.setHideUnknownChecked === 'function') {
        control.setHideUnknownChecked(!!state.hideUnknown);
      }
    }
  }

  function findNodeNames(query) {
    var q = (query || '').trim().toLowerCase();
    if (!q) return [];
    var hits = [];
    var selected = {};
    state.names.forEach(function (n) {
      selected[String(n).toLowerCase()] = true;
    });
    nodeNames.forEach(function (name) {
      var lower = name.toLowerCase();
      if (selected[lower]) return;
      var pos = lower.indexOf(q);
      if (pos === -1) return;
      var rank = pos === 0 ? 0 : /[-_.\s]/.test(lower.charAt(pos - 1)) ? 1 : 2;
      hits.push({ name: name, rank: rank });
    });
    hits.sort(function (a, b) {
      return a.rank - b.rank || a.name.localeCompare(b.name);
    });
    return hits.slice(0, NODE_RESULT_LIMIT);
  }

  function setLayerVisible(on) {
    if (!map) return;
    syncingLayer = true;
    try {
      var isOn = map.hasLayer(coverageLayer);
      if (on && !isOn) map.addLayer(coverageLayer);
      if (!on && isOn) map.removeLayer(coverageLayer);
    } finally {
      syncingLayer = false;
    }
  }

  function isLayerVisible() {
    return !!(map && map.hasLayer(coverageLayer));
  }

  function setMode(mode, opts) {
    opts = opts || {};
    state.mode = normalizeMode(mode);
    if (!opts.skipSave) saveState();
    setLayerVisible(state.mode !== 'off');
    redraw();
  }

  var CoverageControl = L.Control.extend({
    options: { position: 'verticalcenterleft' },

    onAdd: function () {
      var self = this;
      var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control meshmap-coverage');
      container.title = 'Radio coverage filters';

      var button = L.DomUtil.create('a', 'meshmap-coverage-button', container);
      button.href = '#';
      button.setAttribute('role', 'button');
      button.setAttribute('aria-label', 'Radio coverage filters');
      button.innerHTML = COVERAGE_SVG;

      var panel = L.DomUtil.create('div', 'meshmap-coverage-panel', container);
      panel.innerHTML =
        '<div class="meshmap-coverage-header">Radio Coverage</div>' +
        '<div class="meshmap-coverage-section meshmap-coverage-show-row">' +
        '<div class="meshmap-coverage-show-main">' +
        '<div class="meshmap-coverage-label">Show coverage</div>' +
        '<select class="meshmap-coverage-mode" aria-label="Show coverage mode">' +
        '<option value="off">Off</option>' +
        '<option value="band">Band</option>' +
        '<option value="node">Node</option>' +
        '<option value="bandwidth">Bandwidth</option>' +
        '</select>' +
        '</div>' +
        '<label class="meshmap-coverage-hide-unknown" title="If Antenna beam width or direction is unknown, hide it instead of assuming Omni">' +
        '<input type="checkbox" class="meshmap-coverage-hide-unknown-input"> Hide Unknown</label>' +
        '</div>' +
        '<div class="meshmap-coverage-section">' +
        '<div class="meshmap-coverage-label">Node name</div>' +
        '<div class="meshmap-coverage-chips" data-chips="names"></div>' +
        '<input type="search" class="meshmap-coverage-name-input" placeholder="Type node name..." autocomplete="off" spellcheck="false">' +
        '<ul class="meshmap-coverage-suggest"></ul>' +
        '</div>' +
        '<div class="meshmap-coverage-section">' +
        '<div class="meshmap-coverage-label">Bandwidth</div>' +
        '<div class="meshmap-coverage-checks" data-checks="bandwidths"></div>' +
        '</div>' +
        '<div class="meshmap-coverage-section">' +
        '<div class="meshmap-coverage-label">Band</div>' +
        '<div class="meshmap-coverage-checks" data-checks="bands"></div>' +
        '</div>' +
        '<div class="meshmap-coverage-section">' +
        '<div class="meshmap-coverage-label">Channel</div>' +
        '<div class="meshmap-coverage-checks meshmap-coverage-channels" data-checks="channels"></div>' +
        '</div>' +
        '<div class="meshmap-coverage-actions">' +
        '<button type="button" class="meshmap-coverage-clear">Clear filter</button>' +
        '</div>' +
        '<div class="meshmap-coverage-section meshmap-coverage-range-row">' +
        '<label class="meshmap-coverage-label" for="meshmap-coverage-range">Max range (<span class="meshmap-coverage-unit">mi</span>)</label>' +
        '<div class="meshmap-coverage-range-controls">' +
        '<input type="range" class="meshmap-coverage-range" id="meshmap-coverage-range" min="' + MIN_RANGE + '" max="' + MAX_RANGE + '" step="1">' +
        '<input type="number" class="meshmap-coverage-range-num" min="' + MIN_RANGE + '" max="' + MAX_RANGE + '" step="1">' +
        '</div>' +
        '</div>' +
        '<div class="meshmap-coverage-status"></div>' +
        '<div class="meshmap-coverage-legend">' +
        '<span class="meshmap-coverage-legend-known">Antenna Pattern</span>' +
        '<span class="meshmap-coverage-legend-unknown">Pattern Unknown</span>' +
        '</div>';

      this._container = container;
      this._panel = panel;
      this._button = button;
      this._modeSelect = panel.querySelector('.meshmap-coverage-mode');
      this._hideUnknownInput = panel.querySelector('.meshmap-coverage-hide-unknown-input');
      this._chips = panel.querySelector('[data-chips="names"]');
      this._nameInput = panel.querySelector('.meshmap-coverage-name-input');
      this._suggest = panel.querySelector('.meshmap-coverage-suggest');
      this._bwChecks = panel.querySelector('[data-checks="bandwidths"]');
      this._bandChecks = panel.querySelector('[data-checks="bands"]');
      this._chChecks = panel.querySelector('[data-checks="channels"]');
      this._range = panel.querySelector('.meshmap-coverage-range');
      this._rangeNum = panel.querySelector('.meshmap-coverage-range-num');
      this._unit = panel.querySelector('.meshmap-coverage-unit');
      this._status = panel.querySelector('.meshmap-coverage-status');
      this._legend = panel.querySelector('.meshmap-coverage-legend');
      this._clearBtn = panel.querySelector('.meshmap-coverage-clear');
      this._suggestItems = [];
      this._suggestActive = -1;

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      L.DomEvent.disableClickPropagation(panel);
      L.DomEvent.disableScrollPropagation(panel);

      L.DomEvent.on(button, 'click', function (ev) {
        L.DomEvent.preventDefault(ev);
        if (self.isExpanded()) self.collapse();
        else self.expand();
      });

      L.DomEvent.on(this._modeSelect, 'change', function () {
        setMode(self._modeSelect.value);
      });
      L.DomEvent.on(this._hideUnknownInput, 'change', function () {
        state.hideUnknown = !!self._hideUnknownInput.checked;
        saveState();
        self._renderChips();
        redraw();
      });

      L.DomEvent.on(this._nameInput, 'input', function () {
        self._renderSuggest();
      });
      L.DomEvent.on(this._nameInput, 'keydown', function (ev) {
        self._onNameKey(ev);
      });
      L.DomEvent.on(this._nameInput, 'blur', function () {
        setTimeout(function () { self._hideSuggest(); }, 150);
      });

      L.DomEvent.on(this._range, 'input', function () {
        self._setRange(self._range.value);
      });
      L.DomEvent.on(this._rangeNum, 'change', function () {
        self._setRange(self._rangeNum.value);
      });
      L.DomEvent.on(this._clearBtn, 'click', function (ev) {
        L.DomEvent.preventDefault(ev);
        state.names = [];
        state.colors = {};
        state.bandwidths = [];
        state.bands = [];
        state.channels = [];
        saveState();
        self._renderChips();
        self._syncCheckboxes();
        redraw();
      });

      this._fillCheckboxes();
      this._unit.textContent = rangeUnitLabel();
      this._range.value = String(state.range);
      this._rangeNum.value = String(state.range);
      this._renderChips();
      this.setModeSelect(state.mode);
      this.setHideUnknownChecked(!!state.hideUnknown);
      this.updateLegend();
      setLayerVisible(state.mode !== 'off');
      redraw();

      return container;
    },

    isExpanded: function () {
      return L.DomUtil.hasClass(this._container, 'meshmap-coverage-expanded');
    },

    expand: function () {
      L.DomUtil.addClass(this._container, 'meshmap-coverage-expanded');
      L.DomUtil.addClass(this._panel, 'meshmap-coverage-panel-open');
      this._nameInput.focus();
    },

    collapse: function () {
      L.DomUtil.removeClass(this._container, 'meshmap-coverage-expanded');
      L.DomUtil.removeClass(this._panel, 'meshmap-coverage-panel-open');
      this._hideSuggest();
    },

    setModeSelect: function (mode) {
      if (this._modeSelect) this._modeSelect.value = normalizeMode(mode);
    },

    setHideUnknownChecked: function (on) {
      if (this._hideUnknownInput) this._hideUnknownInput.checked = !!on;
    },

    updateLegend: function () {
      if (!this._legend) return;
      var show = state.mode === 'band' || state.mode === 'bandwidth';
      if (show) L.DomUtil.removeClass(this._legend, 'meshmap-coverage-legend-hidden');
      else L.DomUtil.addClass(this._legend, 'meshmap-coverage-legend-hidden');
    },

    updateStatus: function (counts) {
      if (!this._status) return;
      var hiddenNote = counts.hidden
        ? ' · ' + counts.hidden + ' hidden (unknown)'
        : '';
      if (state.mode === 'off') {
        this._status.textContent =
          'Coverage off · ' + (counts.total + counts.hidden) + ' nodes match filters' +
          hiddenNote;
        return;
      }
      this._status.textContent =
        'Showing ' + counts.total + ' nodes: ' +
        counts.directional + ' directional, ' +
        counts.omni + ' omni, ' +
        counts.unknown + (state.mode === 'node' ? ' assumed omni' : ' unknown') +
        hiddenNote;
    },

    _setRange: function (value) {
      var r = num(value);
      if (r === null) r = DEFAULT_RANGE;
      r = Math.max(MIN_RANGE, Math.min(MAX_RANGE, Math.round(r)));
      state.range = r;
      this._range.value = String(r);
      this._rangeNum.value = String(r);
      saveState();
      redraw();
    },

    _fillCheckboxes: function () {
      this._bwChecks.innerHTML = bandwidthOptions.map(function (o) {
        return '<label class="meshmap-coverage-check"><input type="checkbox" data-filter="bandwidths" value="' +
          escapeHtml(o.value) + '"> ' + escapeHtml(o.label) + '</label>';
      }).join('') || '<div class="meshmap-coverage-empty">No bandwidths</div>';

      this._bandChecks.innerHTML = bandOptions.map(function (o) {
        return '<label class="meshmap-coverage-check"><input type="checkbox" data-filter="bands" value="' +
          escapeHtml(o.value) + '"> ' + escapeHtml(o.label) + '</label>';
      }).join('') || '<div class="meshmap-coverage-empty">No bands</div>';

      var html = '';
      var lastBand = null;
      channelOptions.forEach(function (o) {
        if (o.bandKey !== lastBand) {
          lastBand = o.bandKey;
          html += '<div class="meshmap-coverage-channel-group">' +
            escapeHtml(BAND_LABELS[o.bandKey] || o.bandKey) + '</div>';
        }
        html += '<label class="meshmap-coverage-check"><input type="checkbox" data-filter="channels" value="' +
          escapeHtml(o.value) + '"> ' + escapeHtml(o.label) + '</label>';
      });
      this._chChecks.innerHTML = html || '<div class="meshmap-coverage-empty">No channels</div>';

      var self = this;
      Array.prototype.forEach.call(this._panel.querySelectorAll('input[data-filter]'), function (input) {
        L.DomEvent.on(input, 'change', function () {
          self._onFilterCheck(input);
        });
      });
      this._syncCheckboxes();
    },

    _onFilterCheck: function (input) {
      var key = input.getAttribute('data-filter');
      var value = input.value;
      var list = state[key] || [];
      var idx = list.indexOf(value);
      if (input.checked && idx === -1) list.push(value);
      if (!input.checked && idx !== -1) list.splice(idx, 1);
      state[key] = list;
      saveState();
      redraw();
    },

    _syncCheckboxes: function () {
      Array.prototype.forEach.call(this._panel.querySelectorAll('input[data-filter]'), function (input) {
        var key = input.getAttribute('data-filter');
        input.checked = (state[key] || []).indexOf(input.value) !== -1;
      });
    },

    _renderChips: function () {
      var self = this;
      this._chips.innerHTML = state.names.map(function (name) {
        var disabled = isNameChipDisabled(name);
        var color = ensureNodeColor(name);
        var colorHtml = disabled
          ? ''
          : '<input type="color" class="meshmap-coverage-chip-color" value="' + escapeHtml(color) +
            '" title="Coverage color for ' + escapeHtml(name) + '" aria-label="Coverage color for ' +
            escapeHtml(name) + '">';
        return '<span class="meshmap-coverage-chip' +
          (disabled ? ' meshmap-coverage-chip-disabled' : '') +
          '" data-name="' + escapeHtml(name) + '"' +
          (disabled
            ? ' title="Hidden: antenna beam width or direction unknown"'
            : '') +
          '>' +
          colorHtml +
          '<span class="meshmap-coverage-chip-label">' + escapeHtml(name) + '</span>' +
          '<button type="button" class="meshmap-coverage-chip-remove" aria-label="Remove ' +
          escapeHtml(name) + '">&times;</button></span>';
      }).join('');
      Array.prototype.forEach.call(this._chips.querySelectorAll('.meshmap-coverage-chip-color'), function (input) {
        L.DomEvent.on(input, 'input', function () {
          var chip = input.parentNode;
          var name = chip.getAttribute('data-name');
          var hex = normalizeHexColor(input.value);
          if (!hex) return;
          state.colors[colorKey(name)] = hex;
          saveState();
          redraw();
        });
        L.DomEvent.on(input, 'click', function (ev) {
          L.DomEvent.stopPropagation(ev);
        });
      });
      Array.prototype.forEach.call(this._chips.querySelectorAll('.meshmap-coverage-chip-remove'), function (btn) {
        L.DomEvent.on(btn, 'click', function (ev) {
          L.DomEvent.preventDefault(ev);
          var chip = btn.parentNode;
          var name = chip.getAttribute('data-name');
          state.names = state.names.filter(function (n) {
            return String(n).toLowerCase() !== String(name).toLowerCase();
          });
          removeNodeColor(name);
          saveState();
          self._renderChips();
          redraw();
        });
      });
    },

    _hideSuggest: function () {
      this._suggest.innerHTML = '';
      this._suggestItems = [];
      this._suggestActive = -1;
      L.DomUtil.removeClass(this._suggest, 'meshmap-coverage-suggest-open');
    },

    _renderSuggest: function () {
      var self = this;
      var hits = findNodeNames(this._nameInput.value);
      this._suggestItems = hits;
      this._suggestActive = hits.length ? 0 : -1;
      if (!hits.length) {
        this._hideSuggest();
        return;
      }
      this._suggest.innerHTML = hits.map(function (h, i) {
        return '<li class="meshmap-coverage-suggest-item' +
          (i === 0 ? ' meshmap-coverage-suggest-active' : '') +
          '" data-idx="' + i + '" tabindex="-1">' + escapeHtml(h.name) + '</li>';
      }).join('');
      L.DomUtil.addClass(this._suggest, 'meshmap-coverage-suggest-open');
      Array.prototype.forEach.call(this._suggest.querySelectorAll('.meshmap-coverage-suggest-item'), function (li) {
        L.DomEvent.on(li, 'mousedown', function (ev) {
          L.DomEvent.preventDefault(ev);
          var idx = parseInt(li.getAttribute('data-idx'), 10);
          self._pickSuggest(idx);
        });
      });
    },

    _highlightSuggest: function (idx) {
      this._suggestActive = idx;
      Array.prototype.forEach.call(this._suggest.querySelectorAll('.meshmap-coverage-suggest-item'), function (li, i) {
        if (i === idx) L.DomUtil.addClass(li, 'meshmap-coverage-suggest-active');
        else L.DomUtil.removeClass(li, 'meshmap-coverage-suggest-active');
      });
    },

    _pickSuggest: function (idx) {
      var hit = this._suggestItems[idx];
      if (!hit) return;
      var lower = hit.name.toLowerCase();
      var exists = state.names.some(function (n) {
        return String(n).toLowerCase() === lower;
      });
      if (!exists) {
        state.names.push(hit.name);
        ensureNodeColor(hit.name);
      }
      this._nameInput.value = '';
      this._hideSuggest();
      saveState();
      this._renderChips();
      if (state.mode === 'off') setMode('node');
      else redraw();
    },

    _onNameKey: function (ev) {
      if (ev.key === 'ArrowDown') {
        if (!this._suggestItems.length) return;
        L.DomEvent.preventDefault(ev);
        var next = (this._suggestActive + 1) % this._suggestItems.length;
        this._highlightSuggest(next);
      } else if (ev.key === 'ArrowUp') {
        if (!this._suggestItems.length) return;
        L.DomEvent.preventDefault(ev);
        var prev = this._suggestActive <= 0 ? this._suggestItems.length - 1 : this._suggestActive - 1;
        this._highlightSuggest(prev);
      } else if (ev.key === 'Enter') {
        if (this._suggestActive >= 0 && this._suggestItems.length) {
          L.DomEvent.preventDefault(ev);
          this._pickSuggest(this._suggestActive);
        }
      } else if (ev.key === 'Escape') {
        this._hideSuggest();
      }
    }
  });

  function init(leafletMap, allDevices, info) {
    map = leafletMap;
    mapInfo = info || {};
    rfNodes = collectRfNodes(allDevices);
    buildOptionLists(rfNodes);
    loadState();

    // Layer-control session may have Radio Coverage on from an older checkbox UI
    if (state.mode === 'off' && isLayerVisible()) {
      state.mode = 'band';
      saveState();
    }

    if (control) {
      try { map.removeControl(control); } catch (e) {}
      control = null;
    }
    control = new CoverageControl();
    control.addTo(map);

    map.on('overlayadd', function (e) {
      if (syncingLayer) return;
      if (e && e.name === LAYER_NAME && state.mode === 'off') {
        setMode('band');
      }
    });
    map.on('overlayremove', function (e) {
      if (syncingLayer) return;
      if (e && e.name === LAYER_NAME && state.mode !== 'off') {
        setMode('off');
      }
    });
  }

  window.MeshmapCoverage = {
    init: init,
    layer: coverageLayer,
    LAYER_NAME: LAYER_NAME
  };
})(window);
