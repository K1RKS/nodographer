/**
 * Visual Traceroute overlay for Nodographer meshmap.
 *
 * schemaVersion 1 JSON (shared with aredn-traceroute / stableroute / meshinfo):
 * {
 *   schemaVersion: 1,
 *   tool: "aredn-traceroute"|"stableroute",
 *   destination, source, runs, summary, paths: [{ index, key, count, reached, hops: [...] }]
 * }
 *
 * Layer group "Visual Traceroute" draws path polylines on top of stations/links.
 * Paste text/JSON always works; live runs go through meshinfo POST /api/v1/trace
 * (or direct node CGI when the page is on .local.mesh).
 */
(function (window) {
  'use strict';

  var LAYER_NAME = 'Visual Traceroute';
  var PATH_COLORS = [
    '#e41a1c', '#377eb8', '#4daf4a', '#984ea3',
    '#ff7f00', '#a65628', '#f781bf', '#1b9e77'
  ];

  var TRACE_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 2c-1.1 0-2 .9-2 2v2.2C7.1 7 5 9.7 5 13c0 3.9 3.1 7 7 7s7-3.1 7-7c0-3.3-2.1-6-5-6.8V4c0-1.1-.9-2-2-2zm0 7c2.2 0 4 1.8 4 4s-1.8 4-4 4-4-1.8-4-4 1.8-4 4-4z"/>' +
    '<circle cx="12" cy="13" r="1.5" fill="currentColor"/>' +
    '</svg>';

  var traceLayer = L.layerGroup();
  var map = null;
  var mapInfo = null;
  var deviceByKey = {};
  var deviceByIp = {};
  var nodeNames = [];
  var control = null;
  var syncingLayer = false;
  var state = {
    doc: null,
    selected: 'all', // 'all' | path index number
    status: '',
    busy: false
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function nodeKey(name) {
    if (typeof meshmapNodeKey === 'function') {
      return meshmapNodeKey(name);
    }
    return String(name || '').toLowerCase().replace(/\.local\.mesh$/i, '');
  }

  function indexDevices(allDevices) {
    deviceByKey = {};
    deviceByIp = {};
    nodeNames = [];
    if (!allDevices || typeof allDevices !== 'object') {
      return;
    }
    Object.keys(allDevices).forEach(function (band) {
      var arr = allDevices[band];
      if (!arr || !arr.length) return;
      for (var i = 0; i < arr.length; i++) {
        var d = arr[i];
        if (!d || !d.node) continue;
        var key = nodeKey(d.node);
        deviceByKey[key] = d;
        if (d.wlan_ip) {
          deviceByIp[String(d.wlan_ip)] = d;
        }
        nodeNames.push(d.node);
      }
    });
    nodeNames.sort(function (a, b) {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    });
  }

  function findDevice(hostname, ip) {
    if (hostname) {
      var byName = deviceByKey[nodeKey(hostname)];
      if (byName) return byName;
    }
    if (ip && deviceByIp[String(ip)]) {
      return deviceByIp[String(ip)];
    }
    return null;
  }

  function hopIdentity(hop) {
    if (!hop || hop.unreachable) return '*';
    var host = nodeKey(hop.hostname);
    if (host && host !== hop.ip) return host;
    if (hop.ip) return String(hop.ip);
    return '*';
  }

  function pathKeyFromHops(hops) {
    return (hops || []).map(hopIdentity).join('|');
  }

  function parseHopLine(line) {
    line = String(line || '').trim();
    if (!line) return null;
    var m = line.match(/^(\d+)\s+\*/);
    if (m) {
      return {
        hop: parseInt(m[1], 10),
        hostname: null,
        ip: null,
        linkType: null,
        rttMs: null,
        unreachable: true
      };
    }
    m = line.match(
      /^(\d+)\s+([^\s]+)\s+\(([0-9.]+)\)\s+(\d+(?:\.\d+)?)\s+ms(?:\s+[0-9.+-]+,[0-9.+-]+)?(?:\s+(DtD|RF|WG|Xlink|-))?/
    );
    if (m) {
      return {
        hop: parseInt(m[1], 10),
        hostname: nodeKey(m[2]) || m[2],
        ip: m[3],
        linkType: m[5] || null,
        rttMs: Math.round(parseFloat(m[4])),
        unreachable: false
      };
    }
    m = line.match(/^(\d+)\s+([0-9.]+)\s+(\d+(?:\.\d+)?)\s+ms(?:\s+(DtD|RF|WG|Xlink|-))?/);
    if (m) {
      return {
        hop: parseInt(m[1], 10),
        hostname: m[2],
        ip: m[2],
        linkType: m[4] || null,
        rttMs: Math.round(parseFloat(m[3])),
        unreachable: false
      };
    }
    return null;
  }

  function parseStableHopLine(line) {
    line = String(line || '').trim();
    if (!line) return null;
    var m = line.match(/^(\d+)\s+\*\s*(?:avg\s+(\d+)ms\s+\+-\s+(\d+)ms)?/);
    if (m) {
      var avg = m[2] != null ? parseInt(m[2], 10) : null;
      return {
        hop: parseInt(m[1], 10),
        hostname: null,
        ip: null,
        linkType: null,
        rttMs: avg,
        rttAvgMs: avg,
        rttDevMs: m[3] != null ? parseInt(m[3], 10) : null,
        unreachable: true
      };
    }
    m = line.match(
      /^(\d+)\s+([^\s(]+)\s+\(([0-9.]+)\)(?:\s+(DtD|RF|WG|Xlink|-))?\s*(?:avg\s+(\d+)ms\s+\+-\s+(\d+)ms)?/
    );
    if (m) {
      avg = m[5] != null ? parseInt(m[5], 10) : null;
      return {
        hop: parseInt(m[1], 10),
        hostname: nodeKey(m[2]) || m[2],
        ip: m[3],
        linkType: m[4] || null,
        rttMs: avg,
        rttAvgMs: avg,
        rttDevMs: m[6] != null ? parseInt(m[6], 10) : null,
        unreachable: false
      };
    }
    return null;
  }

  function parseTracerouteText(text) {
    var hops = [];
    var dest = null;
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var tm = line.match(/^traceroute to\s+(\S+)/i);
      if (tm && !dest) {
        dest = nodeKey(tm[1].replace(/,$/, ''));
      }
      var hop = parseHopLine(line);
      if (hop) hops.push(hop);
    });
    var reached = hops.length > 0 && !hops[hops.length - 1].unreachable;
    return {
      schemaVersion: 1,
      tool: 'aredn-traceroute',
      destination: dest,
      source: null,
      runs: 1,
      summary: {
        uniquePaths: hops.length ? 1 : 0,
        shortest: hops.length,
        longest: hops.length,
        unreachable: reached ? 0 : 1,
        mostCommonCount: hops.length ? 1 : 0
      },
      paths: hops.length ? [{
        index: 1,
        key: pathKeyFromHops(hops),
        count: 1,
        reached: reached,
        hops: hops
      }] : []
    };
  }

  function parseStablerouteText(text) {
    var dest = null;
    var runs = 0;
    var unreachable = 0;
    var shortest = 0;
    var longest = 0;
    var using = 'using traceroute';
    var paths = [];
    var current = null;
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      var m = line.match(/^stableroute\([^)]+\):\s+destination\s+(\S+)\s+runs\s+(\d+)/i);
      if (m) {
        dest = m[1];
        runs = parseInt(m[2], 10);
        return;
      }
      if (line.indexOf('using ') === 0) {
        using = line.trim();
        return;
      }
      m = line.match(/^\s*Unreachable:\s+(\d+)/i);
      if (m) {
        unreachable = parseInt(m[1], 10);
        return;
      }
      m = line.match(/^\s*shortest route:\s+(\d+)/i);
      if (m) {
        shortest = parseInt(m[1], 10);
        return;
      }
      m = line.match(/^\s*longest route:\s+(\d+)/i);
      if (m) {
        longest = parseInt(m[1], 10);
        return;
      }
      m = line.match(/^Path\s+(\d+):\s+(\d+)\/(\d+)\s+\((\d+)%\)/i);
      if (m) {
        if (current) paths.push(current);
        current = {
          index: parseInt(m[1], 10),
          key: '',
          count: parseInt(m[2], 10),
          reached: line.toLowerCase().indexOf('[unreachable]') < 0,
          hops: []
        };
        if (!runs) runs = parseInt(m[3], 10);
        return;
      }
      if (current) {
        var hop = parseStableHopLine(line);
        if (hop) current.hops.push(hop);
      }
    });
    if (current) paths.push(current);
    paths.forEach(function (p) {
      p.key = pathKeyFromHops(p.hops);
      if (!shortest || p.hops.length < shortest) shortest = p.hops.length;
      if (p.hops.length > longest) longest = p.hops.length;
    });
    return {
      schemaVersion: 1,
      tool: 'stableroute',
      destination: dest ? nodeKey(dest) : null,
      source: null,
      using: using,
      runs: runs || paths.reduce(function (s, p) { return s + p.count; }, 0),
      summary: {
        uniquePaths: paths.length,
        shortest: shortest,
        longest: longest,
        unreachable: unreachable,
        mostCommonCount: paths[0] ? paths[0].count : 0
      },
      paths: paths
    };
  }

  function parsePaste(raw) {
    var text = String(raw || '').trim();
    if (!text) {
      throw new Error('Nothing to parse');
    }
    if (text.charAt(0) === '{') {
      var doc = JSON.parse(text);
      if (!doc || !doc.paths) {
        throw new Error('JSON is missing paths[]');
      }
      return doc;
    }
    if (/^stableroute\(/i.test(text) || /Path\s+1:/i.test(text)) {
      return parseStablerouteText(text);
    }
    return parseTracerouteText(text);
  }

  function resolveHopLatLon(hop) {
    if (hop && hop.lat != null && hop.lon != null && isFinite(Number(hop.lat)) && isFinite(Number(hop.lon))) {
      var lat = Number(hop.lat);
      var lon = Number(hop.lon);
      if (lat !== 0 || lon !== 0) {
        return { lat: lat, lon: lon, via: 'hop' };
      }
    }
    var d = findDevice(hop && hop.hostname, hop && hop.ip);
    if (d && d.lat != null && d.lon != null) {
      return { lat: Number(d.lat), lon: Number(d.lon), via: 'map', node: d.node };
    }
    return null;
  }

  function sourceLatLon(doc) {
    if (!doc || !doc.source) return null;
    var d = findDevice(doc.source, null);
    if (d && d.lat != null && d.lon != null) {
      return { lat: Number(d.lat), lon: Number(d.lon), hostname: d.node, via: 'source' };
    }
    return null;
  }

  function pathColor(index) {
    return PATH_COLORS[(Math.max(1, index) - 1) % PATH_COLORS.length];
  }

  function hopPopupHtml(hop, pathIndex) {
    var lines = [
      '<strong>Path ' + pathIndex + ' · hop ' + (hop.hop != null ? hop.hop : '?') + '</strong>',
      escapeHtml(hop.hostname || '*') + (hop.ip ? ' (' + escapeHtml(hop.ip) + ')' : '')
    ];
    if (hop.linkType) lines.push('Link: ' + escapeHtml(hop.linkType));
    if (hop.rttAvgMs != null) {
      lines.push('RTT avg ' + hop.rttAvgMs + 'ms' + (hop.rttDevMs != null ? ' +- ' + hop.rttDevMs + 'ms' : ''));
    } else if (hop.rttMs != null) {
      lines.push('RTT ' + hop.rttMs + 'ms');
    }
    if (hop.unreachable) lines.push('(unreachable)');
    return lines.join('<br>');
  }

  function clearDraw() {
    traceLayer.clearLayers();
  }

  function drawDoc() {
    clearDraw();
    var unresolved = [];
    var doc = state.doc;
    if (!doc || !doc.paths || !doc.paths.length) {
      setStatus(state.status || 'No paths to draw');
      renderPathControls();
      return;
    }
    var paths = doc.paths;
    var selected = state.selected;
    paths.forEach(function (path) {
      if (selected !== 'all' && Number(selected) !== Number(path.index)) {
        return;
      }
      var color = pathColor(path.index);
      var coords = [];
      var src = sourceLatLon(doc);
      if (src) {
        coords.push([src.lat, src.lon]);
      }
      (path.hops || []).forEach(function (hop) {
        var pos = resolveHopLatLon(hop);
        if (!pos) {
          unresolved.push((hop.hostname || hop.ip || '*') + ' (path ' + path.index + ')');
          if (coords.length) {
            flushPolyline(coords, color, path);
            coords = [];
          }
          return;
        }
        coords.push([pos.lat, pos.lon]);
        var circle = L.circleMarker([pos.lat, pos.lon], {
          radius: 6,
          color: color,
          weight: 2,
          fillColor: '#fff',
          fillOpacity: 0.95,
          opacity: 1
        });
        circle.bindPopup(hopPopupHtml(hop, path.index));
        traceLayer.addLayer(circle);
      });
      flushPolyline(coords, color, path);
    });
    var msg = (doc.tool || 'trace') + ': ' + (doc.paths.length) + ' path(s)';
    if (doc.destination) msg += ' → ' + doc.destination;
    if (unresolved.length) {
      msg += ' · unresolved: ' + unresolved.slice(0, 6).join(', ') +
        (unresolved.length > 6 ? '…' : '');
    }
    setStatus(msg);
    renderPathControls();
  }

  function flushPolyline(coords, color, path) {
    if (!coords || coords.length < 2) return;
    var line = L.polyline(coords, {
      color: color,
      weight: 5,
      opacity: 0.9,
      lineJoin: 'round',
      interactive: true
    });
    var label = 'Path ' + path.index;
    if (path.count != null && state.doc && state.doc.runs) {
      label += ' (' + path.count + '/' + state.doc.runs + ')';
    }
    line.bindPopup(escapeHtml(label) + (path.reached === false ? '<br>[unreachable]' : ''));
    traceLayer.addLayer(line);
  }

  function setStatus(msg) {
    state.status = msg || '';
    if (control && control._status) {
      control._status.textContent = state.status;
    }
  }

  function ensureLayerOn() {
    if (!map) return;
    if (!map.hasLayer(traceLayer)) {
      syncingLayer = true;
      map.addLayer(traceLayer);
      syncingLayer = false;
    }
  }

  function meshinfoTraceUrl() {
    if (!window.NodographerConfig || typeof NodographerConfig.dataUrl !== 'function') {
      return '';
    }
    try {
      var cfg = NodographerConfig.config || {};
      var meshinfo = cfg.meshinfo || {};
      if (meshinfo.traceUrl) {
        return String(meshinfo.traceUrl);
      }
      var baseStr = String(meshinfo.baseUrl || '');
      var u = new URL(NodographerConfig.dataUrl(''));
      var path = u.pathname || '';
      // Absolute /api/v1/, nginx proxy "meshinfo/", or any non-snapshot base.
      // Skip local snapshot dirs like "meshinfo/current/" or "data/".
      if (path.indexOf('/api/v1') >= 0 || baseStr.indexOf('api/v1') >= 0) {
        return new URL('trace', u).href;
      }
      if (/\/current\/?$/i.test(path) || /\/data\/?$/i.test(path)) {
        return '';
      }
      if (baseStr && !/current\/?\s*$/i.test(baseStr) && !/^data\/?$/i.test(baseStr.trim())) {
        return new URL('trace', u).href;
      }
    } catch (err) {
      return '';
    }
    return '';
  }

  function onMeshHost() {
    try {
      return /\.local\.mesh$/i.test(window.location.hostname);
    } catch (err) {
      return false;
    }
  }

  function applyDoc(doc) {
    state.doc = doc;
    state.selected = 'all';
    ensureLayerOn();
    drawDoc();
  }

  function renderPathControls() {
    if (!control || !control._paths) return;
    var box = control._paths;
    box.innerHTML = '';
    var doc = state.doc;
    if (!doc || !doc.paths || !doc.paths.length) {
      box.textContent = 'No paths loaded.';
      return;
    }
    var allLabel = document.createElement('label');
    allLabel.className = 'meshmap-vtrace-path';
    var allRadio = document.createElement('input');
    allRadio.type = 'radio';
    allRadio.name = 'meshmap-vtrace-path';
    allRadio.value = 'all';
    allRadio.checked = state.selected === 'all';
    allRadio.addEventListener('change', function () {
      state.selected = 'all';
      drawDoc();
    });
    allLabel.appendChild(allRadio);
    allLabel.appendChild(document.createTextNode(' All paths'));
    box.appendChild(allLabel);

    doc.paths.forEach(function (path) {
      var label = document.createElement('label');
      label.className = 'meshmap-vtrace-path';
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'meshmap-vtrace-path';
      radio.value = String(path.index);
      radio.checked = Number(state.selected) === Number(path.index);
      radio.addEventListener('change', function () {
        state.selected = path.index;
        drawDoc();
      });
      var swatch = document.createElement('span');
      swatch.className = 'meshmap-vtrace-swatch';
      swatch.style.background = pathColor(path.index);
      var text = ' Path ' + path.index;
      if (path.count != null && doc.runs) {
        text += ' (' + path.count + '/' + doc.runs + ')';
      }
      if (path.reached === false) text += ' [unreach]';
      label.appendChild(radio);
      label.appendChild(swatch);
      label.appendChild(document.createTextNode(text));
      box.appendChild(label);
    });
  }

  function setBusy(busy) {
    state.busy = !!busy;
    if (control && control._runBtn) {
      control._runBtn.disabled = state.busy;
    }
    if (control && control._directBtn) {
      control._directBtn.disabled = state.busy;
    }
  }

  async function runViaMeshinfo(tool, source, destination, n) {
    var url = meshinfoTraceUrl();
    if (!url) {
      throw new Error('meshinfo API base not configured (need meshinfo.baseUrl ending in /api/v1/)');
    }
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: tool,
        source: source,
        destination: destination,
        n: n
      })
    });
    var payload = null;
    try {
      payload = await resp.json();
    } catch (err) {
      payload = null;
    }
    if (!resp.ok) {
      var errMsg = (payload && payload.error) || ('HTTP ' + resp.status);
      throw new Error(errMsg);
    }
    if (!payload || !payload.paths) {
      throw new Error('meshinfo returned no paths');
    }
    return payload;
  }

  async function runDirect(tool, source, destination, n) {
    var host = nodeKey(source) + '.local.mesh';
    var qs = 'server=' + encodeURIComponent(destination) + '&format=json';
    if (tool === 'stableroute') {
      qs += '&n=' + encodeURIComponent(String(n || 10));
    }
    var path = tool === 'stableroute' ? '/cgi-bin/stableroute' : '/cgi-bin/traceroute';
    var resp = await fetch('http://' + host + path + '?' + qs);
    var text = await resp.text();
    if (!resp.ok) {
      throw new Error('node CGI HTTP ' + resp.status);
    }
    var doc;
    if (text.trim().charAt(0) === '{') {
      doc = JSON.parse(text);
    } else if (tool === 'stableroute') {
      doc = parseStablerouteText(text);
    } else {
      doc = parseTracerouteText(text);
    }
    doc.source = nodeKey(source);
    return doc;
  }

  function buildControl() {
    var Ctrl = L.Control.extend({
      options: { position: 'verticalcenterright' },
      onAdd: function () {
        var root = L.DomUtil.create('div', 'leaflet-bar meshmap-vtrace');
        var btn = L.DomUtil.create('a', 'meshmap-vtrace-button', root);
        btn.href = '#';
        btn.title = 'Visual Traceroute';
        btn.setAttribute('aria-label', 'Visual Traceroute');
        btn.innerHTML = TRACE_SVG;

        var panel = L.DomUtil.create('div', 'meshmap-vtrace-panel', root);
        panel.innerHTML =
          '<div class="meshmap-vtrace-header">Visual Traceroute</div>' +
          '<label class="meshmap-vtrace-field">Paste report (JSON or text)' +
          '<textarea class="meshmap-vtrace-paste" rows="5" spellcheck="false" ' +
          'placeholder="Paste aredn-traceroute / stableroute output or JSON"></textarea></label>' +
          '<div class="meshmap-vtrace-row">' +
          '<button type="button" class="meshmap-vtrace-parse">Parse / Draw</button>' +
          '<button type="button" class="meshmap-vtrace-clear">Clear</button>' +
          '</div>' +
          '<hr class="meshmap-vtrace-hr">' +
          '<div class="meshmap-vtrace-subheader">Run live</div>' +
          '<label class="meshmap-vtrace-field">Tool' +
          '<select class="meshmap-vtrace-tool">' +
          '<option value="traceroute">traceroute</option>' +
          '<option value="stableroute">stableroute</option>' +
          '</select></label>' +
          '<label class="meshmap-vtrace-field">Source' +
          '<input list="meshmap-vtrace-nodes" class="meshmap-vtrace-source" autocomplete="off"></label>' +
          '<label class="meshmap-vtrace-field">Destination' +
          '<input list="meshmap-vtrace-nodes" class="meshmap-vtrace-dest" autocomplete="off"></label>' +
          '<label class="meshmap-vtrace-field meshmap-vtrace-n-wrap">Runs (stableroute)' +
          '<input type="number" class="meshmap-vtrace-n" min="1" max="20" value="10"></label>' +
          '<datalist id="meshmap-vtrace-nodes"></datalist>' +
          '<div class="meshmap-vtrace-row">' +
          '<button type="button" class="meshmap-vtrace-run">Run via meshinfo</button>' +
          '<button type="button" class="meshmap-vtrace-direct" hidden>Run direct</button>' +
          '</div>' +
          '<div class="meshmap-vtrace-subheader">Paths</div>' +
          '<div class="meshmap-vtrace-paths"></div>' +
          '<div class="meshmap-vtrace-status"></div>';

        var paste = panel.querySelector('.meshmap-vtrace-paste');
        var parseBtn = panel.querySelector('.meshmap-vtrace-parse');
        var clearBtn = panel.querySelector('.meshmap-vtrace-clear');
        var toolSel = panel.querySelector('.meshmap-vtrace-tool');
        var sourceIn = panel.querySelector('.meshmap-vtrace-source');
        var destIn = panel.querySelector('.meshmap-vtrace-dest');
        var nIn = panel.querySelector('.meshmap-vtrace-n');
        var runBtn = panel.querySelector('.meshmap-vtrace-run');
        var directBtn = panel.querySelector('.meshmap-vtrace-direct');
        var pathsBox = panel.querySelector('.meshmap-vtrace-paths');
        var statusEl = panel.querySelector('.meshmap-vtrace-status');
        var list = panel.querySelector('#meshmap-vtrace-nodes');

        nodeNames.forEach(function (name) {
          var opt = document.createElement('option');
          opt.value = name;
          list.appendChild(opt);
        });
        if (mapInfo && mapInfo.localnode) {
          sourceIn.value = mapInfo.localnode;
        }
        if (onMeshHost()) {
          directBtn.hidden = false;
        }

        this._panel = panel;
        this._status = statusEl;
        this._paths = pathsBox;
        this._runBtn = runBtn;
        this._directBtn = directBtn;

        function togglePanel(open) {
          if (open) {
            L.DomUtil.addClass(root, 'meshmap-vtrace-expanded');
            L.DomUtil.addClass(panel, 'meshmap-vtrace-panel-open');
          } else {
            L.DomUtil.removeClass(root, 'meshmap-vtrace-expanded');
            L.DomUtil.removeClass(panel, 'meshmap-vtrace-panel-open');
          }
        }

        L.DomEvent.disableClickPropagation(root);
        L.DomEvent.disableScrollPropagation(panel);
        L.DomEvent.on(btn, 'click', function (e) {
          L.DomEvent.preventDefault(e);
          var open = !L.DomUtil.hasClass(panel, 'meshmap-vtrace-panel-open');
          togglePanel(open);
          if (open) {
            ensureLayerOn();
          }
        });

        parseBtn.addEventListener('click', function () {
          try {
            applyDoc(parsePaste(paste.value));
          } catch (err) {
            setStatus(String(err.message || err));
          }
        });
        clearBtn.addEventListener('click', function () {
          state.doc = null;
          state.selected = 'all';
          clearDraw();
          paste.value = '';
          setStatus('Cleared');
          renderPathControls();
        });

        async function doRun(direct) {
          var tool = toolSel.value;
          var source = sourceIn.value.trim();
          var destination = destIn.value.trim();
          var n = parseInt(nIn.value, 10) || 10;
          if (!source || !destination) {
            setStatus('Source and destination are required');
            return;
          }
          setBusy(true);
          setStatus(direct ? 'Running on node…' : 'Running via meshinfo…');
          try {
            var doc = direct
              ? await runDirect(tool, source, destination, n)
              : await runViaMeshinfo(tool, source, destination, n);
            applyDoc(doc);
          } catch (err) {
            setStatus(String(err.message || err));
          } finally {
            setBusy(false);
          }
        }
        runBtn.addEventListener('click', function () { doRun(false); });
        directBtn.addEventListener('click', function () { doRun(true); });

        return root;
      }
    });
    return new Ctrl();
  }

  function onOverlayAdd(e) {
    if (syncingLayer) return;
    if (e.name === LAYER_NAME || e.layer === traceLayer) {
      if (state.doc) drawDoc();
      if (control && control._panel) {
        L.DomUtil.addClass(control._container, 'meshmap-vtrace-expanded');
        L.DomUtil.addClass(control._panel, 'meshmap-vtrace-panel-open');
      }
    }
  }

  function onOverlayRemove(e) {
    if (syncingLayer) return;
    if (e.name === LAYER_NAME || e.layer === traceLayer) {
      clearDraw();
      if (control && control._panel) {
        L.DomUtil.removeClass(control._container, 'meshmap-vtrace-expanded');
        L.DomUtil.removeClass(control._panel, 'meshmap-vtrace-panel-open');
      }
    }
  }

  function init(mapInstance, allDevices, info) {
    map = mapInstance;
    mapInfo = info || {};
    indexDevices(allDevices);
    if (control) {
      try { map.removeControl(control); } catch (err) { /* ignore */ }
    }
    control = buildControl();
    control.addTo(map);
    map.on('overlayadd', onOverlayAdd);
    map.on('overlayremove', onOverlayRemove);
    renderPathControls();
  }

  window.MeshmapVisualTrace = {
    layer: traceLayer,
    LAYER_NAME: LAYER_NAME,
    init: init,
    parsePaste: parsePaste
  };
})(window);
