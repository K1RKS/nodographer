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
  var SESSION_KEY = 'visualTrace';
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
  var restoringSession = false;
  var progressTimer = null;
  var progressStartedAt = 0;
  var state = {
    doc: null,
    rawText: '',
    selected: 'all', // 'all' | path index number
    status: '',
    busy: false,
    hideLinks: true,
    offsetPaths: true,
    autoCenter: true,
    showHop: false,
    showDelay: false,
    consoleMinimized: false,
    panelOpen: false,
    modeTab: 'paste', // 'paste' | 'live'
    optionsMinimized: true,
    panelPos: null, // { left, top } map-container px, or null for CSS default
    consolePos: null
  };

  function saveSession() {
    if (restoringSession || !window.MeshmapSession) return;
    var patch = {};
    var form = control && control._form ? control._form : {};
    patch[SESSION_KEY] = {
      tool: form.toolSel ? form.toolSel.value : 'traceroute',
      source: form.sourceIn ? form.sourceIn.value : '',
      destination: form.destIn ? form.destIn.value : '',
      n: form.nIn ? (parseInt(form.nIn.value, 10) || 5) : 5,
      paste: form.paste ? form.paste.value : '',
      hideLinks: !!state.hideLinks,
      offsetPaths: !!state.offsetPaths,
      autoCenter: !!state.autoCenter,
      showHop: !!state.showHop,
      showDelay: !!state.showDelay,
      consoleMinimized: !!state.consoleMinimized,
      panelOpen: !!state.panelOpen,
      modeTab: state.modeTab === 'live' ? 'live' : 'paste',
      optionsMinimized: !!state.optionsMinimized,
      panelPos: state.panelPos,
      consolePos: state.consolePos,
      selected: state.selected,
      status: state.status || '',
      rawText: state.rawText || '',
      doc: state.doc || null
    };
    MeshmapSession.write(patch);
  }

  function isCompactUi() {
    if (window.MeshmapMobile && typeof MeshmapMobile.isCompactUi === 'function') {
      return !!MeshmapMobile.isCompactUi();
    }
    try {
      return window.matchMedia('(max-width: 700px), (pointer: coarse)').matches;
    } catch (err) {
      return window.innerWidth <= 700;
    }
  }

  function normalizePos(pos) {
    if (!pos || typeof pos !== 'object') return null;
    var left = Number(pos.left);
    var top = Number(pos.top);
    if (!isFinite(left) || !isFinite(top)) return null;
    return { left: left, top: top };
  }

  function clampPosToMap(el, pos) {
    if (!map || !el || !pos) return pos;
    var mapEl = map.getContainer();
    var mapW = mapEl.clientWidth || 0;
    var mapH = mapEl.clientHeight || 0;
    var w = el.offsetWidth || 280;
    var h = el.offsetHeight || 120;
    var margin = 4;
    var left = Math.max(margin, Math.min(pos.left, Math.max(margin, mapW - w - margin)));
    var top = Math.max(margin, Math.min(pos.top, Math.max(margin, mapH - h - margin)));
    return { left: left, top: top };
  }

  function applyFloatingPos(el, pos, placedClass) {
    if (!el) return;
    var n = normalizePos(pos);
    if (!n) {
      el.style.left = '';
      el.style.top = '';
      el.style.right = '';
      el.style.bottom = '';
      if (placedClass) L.DomUtil.removeClass(el, placedClass);
      return;
    }
    n = clampPosToMap(el, n);
    el.style.left = Math.round(n.left) + 'px';
    el.style.top = Math.round(n.top) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    if (placedClass) L.DomUtil.addClass(el, placedClass);
  }

  /**
   * Pointer/touch drag for floating map overlays. Starts from handle only;
   * ignores interactive controls inside the handle.
   */
  function enableFloatingDrag(el, handle, opts) {
    opts = opts || {};
    if (!el || !handle || !map) return;
    var placedClass = opts.placedClass || 'meshmap-vtrace-floating-placed';
    var onMoveEnd = typeof opts.onMoveEnd === 'function' ? opts.onMoveEnd : null;
    var dragging = false;
    var startX = 0;
    var startY = 0;
    var origLeft = 0;
    var origTop = 0;
    var pointerId = null;

    function eventPoint(e) {
      if (e.touches && e.touches[0]) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
      if (e.changedTouches && e.changedTouches[0]) {
        return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
      }
      return { x: e.clientX, y: e.clientY };
    }

    function shouldIgnoreTarget(target) {
      if (!target || !target.closest) return false;
      return !!target.closest('button, a, input, select, textarea, label, .meshmap-vtrace-tabs');
    }

    function onDown(e) {
      if (shouldIgnoreTarget(e.target)) return;
      if (e.type === 'mousedown' && e.button != null && e.button !== 0) return;
      var pt = eventPoint(e);
      var mapRect = map.getContainer().getBoundingClientRect();
      var rect = el.getBoundingClientRect();
      dragging = true;
      pointerId = e.pointerId != null ? e.pointerId : null;
      startX = pt.x;
      startY = pt.y;
      origLeft = rect.left - mapRect.left;
      origTop = rect.top - mapRect.top;
      applyFloatingPos(el, { left: origLeft, top: origTop }, placedClass);
      L.DomUtil.addClass(el, 'meshmap-vtrace-dragging');
      try {
        if (el.setPointerCapture && pointerId != null) el.setPointerCapture(pointerId);
      } catch (err) { /* ignore */ }
      L.DomEvent.stop(e);
    }

    function onMove(e) {
      if (!dragging) return;
      if (pointerId != null && e.pointerId != null && e.pointerId !== pointerId) return;
      var pt = eventPoint(e);
      var next = clampPosToMap(el, {
        left: origLeft + (pt.x - startX),
        top: origTop + (pt.y - startY)
      });
      applyFloatingPos(el, next, placedClass);
      L.DomEvent.stop(e);
    }

    function onUp(e) {
      if (!dragging) return;
      if (pointerId != null && e.pointerId != null && e.pointerId !== pointerId) return;
      dragging = false;
      L.DomUtil.removeClass(el, 'meshmap-vtrace-dragging');
      try {
        if (el.releasePointerCapture && pointerId != null) el.releasePointerCapture(pointerId);
      } catch (err) { /* ignore */ }
      pointerId = null;
      var left = parseFloat(el.style.left);
      var top = parseFloat(el.style.top);
      if (onMoveEnd && isFinite(left) && isFinite(top)) {
        onMoveEnd(clampPosToMap(el, { left: left, top: top }));
      }
    }

    L.DomUtil.addClass(handle, 'meshmap-vtrace-drag-handle');
    if (window.PointerEvent) {
      handle.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    } else {
      handle.addEventListener('mousedown', onDown);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      handle.addEventListener('touchstart', onDown, { passive: false });
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
    }
  }

  function reclampFloatingPanels() {
    if (control && control._panel && state.panelPos) {
      state.panelPos = clampPosToMap(control._panel, state.panelPos);
      applyFloatingPos(control._panel, state.panelPos, 'meshmap-vtrace-floating-placed');
    }
    if (control && control._console && state.consolePos) {
      state.consolePos = clampPosToMap(control._console, state.consolePos);
      applyFloatingPos(control._console, state.consolePos, 'meshmap-vtrace-floating-placed');
    }
  }

  function readSavedSession() {
    if (!window.MeshmapSession) return null;
    var s = MeshmapSession.read();
    var v = s && s[SESSION_KEY];
    return v && typeof v === 'object' ? v : null;
  }

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
    var m = line.match(/^(\d+)\s+\*\s*(?:avg\s+(\d+)ms\s+(?:\+-|\u00b1)\s+(\d+)ms)?/);
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
      /^(\d+)\s+([^\s(]+)\s+\(([0-9.]+)\)(?:\s+(DtD|RF|WG|Xlink|-))?\s*(?:avg\s+(\d+)ms\s+(?:\+-|\u00b1)\s+(\d+)ms)?/
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
    // IP-only hop: "3 172.31.69.37 -  avg 59ms +- 22ms"
    m = line.match(
      /^(\d+)\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\s+(DtD|RF|WG|Xlink|-))?\s*(?:avg\s+(\d+)ms\s+(?:\+-|\u00b1)\s+(\d+)ms)?/
    );
    if (m) {
      avg = m[4] != null ? parseInt(m[4], 10) : null;
      return {
        hop: parseInt(m[1], 10),
        hostname: m[2],
        ip: m[2],
        linkType: m[3] && m[3] !== '-' ? m[3] : null,
        rttMs: avg,
        rttAvgMs: avg,
        rttDevMs: m[5] != null ? parseInt(m[5], 10) : null,
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
      if (!doc || !Array.isArray(doc.paths) || !doc.paths.length) {
        throw new Error('JSON has no paths[]');
      }
      return doc;
    }
    if (/^stableroute\(/i.test(text) || /Path\s+1:/i.test(text)) {
      var stableDoc = parseStablerouteText(text);
      if (!stableDoc.paths || !stableDoc.paths.length) {
        throw new Error('stableroute report has no paths');
      }
      return stableDoc;
    }
    var trDoc = parseTracerouteText(text);
    if (!trDoc.paths || !trDoc.paths.length) {
      throw new Error('traceroute report has no hops');
    }
    return trDoc;
  }

  /** Prefer live spiderfy marker position when the node is on the map. */
  function markerLatLonForNode(hostname, ip) {
    var d = findDevice(hostname, ip);
    var names = [];
    if (hostname) names.push(hostname);
    if (d && d.node) names.push(d.node);
    if (typeof oms === 'undefined' || !oms || typeof oms.getMarkers !== 'function') {
      return null;
    }
    var markers = oms.getMarkers();
    var want = {};
    names.forEach(function (n) {
      var k = nodeKey(n);
      if (k) want[k] = true;
    });
    if (!Object.keys(want).length) return null;
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      var title = m && m.options && m.options.title;
      if (!title || !want[nodeKey(title)]) continue;
      var ll = m.getLatLng();
      if (!ll) continue;
      return { lat: ll.lat, lon: ll.lng, via: 'marker', node: title, hostname: title };
    }
    return null;
  }

  function resolveHopLatLon(hop) {
    var fromMarker = markerLatLonForNode(hop && hop.hostname, hop && hop.ip);
    if (fromMarker) return fromMarker;
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

  function sourceNameCandidates(doc) {
    var names = [];
    function add(n) {
      n = String(n || '').trim();
      if (!n) return;
      var k = nodeKey(n);
      if (!k) return;
      if (names.indexOf(k) < 0) names.push(k);
      if (names.indexOf(n) < 0) names.push(n);
    }
    if (doc) {
      add(doc.source);
      if (doc.proxy && doc.proxy.sourceName) add(doc.proxy.sourceName);
    }
    if (control && control._form && control._form.sourceIn) {
      add(control._form.sourceIn.value);
    }
    return names;
  }

  function latLonFromNameOrIp(hostname, ip) {
    var fromMarker = markerLatLonForNode(hostname, ip);
    if (fromMarker) return fromMarker;
    var d = findDevice(hostname, ip);
    if (d && d.lat != null && d.lon != null) {
      return {
        lat: Number(d.lat),
        lon: Number(d.lon),
        hostname: d.node,
        node: d.node,
        via: 'map'
      };
    }
    return null;
  }

  function sourceLatLon(doc) {
    var names = sourceNameCandidates(doc);
    for (var i = 0; i < names.length; i++) {
      var hit = latLonFromNameOrIp(names[i], null);
      if (hit) {
        hit.via = hit.via === 'marker' ? 'source-marker' : 'source';
        return hit;
      }
    }
    // Proxy may only know localnode by IP (name is not on the map).
    var sip = doc && doc.proxy && doc.proxy.sourceIp;
    if (sip) {
      var byIp = latLonFromNameOrIp(null, sip);
      if (byIp) {
        byIp.via = 'sourceIp';
        return byIp;
      }
    }
    return null;
  }

  function pathColor(index) {
    return PATH_COLORS[(Math.max(1, index) - 1) % PATH_COLORS.length];
  }

  function hopDisplayName(hop) {
    if (!hop) return '*';
    if (hop.unreachable) return '*';
    if (hop.hostname && hop.ip && hop.hostname !== hop.ip) {
      return hop.hostname + ' (' + hop.ip + ')';
    }
    return hop.hostname || hop.ip || '*';
  }

  function vertexDisplayName(vertex) {
    if (!vertex) return '?';
    if (vertex.hop) return hopDisplayName(vertex.hop);
    if (vertex.hostname) return vertex.hostname;
    if (state.doc && state.doc.source) return String(state.doc.source);
    return 'source';
  }

  function wrapVtracePopup(innerHtml) {
    return '<div class="meshmap-vtrace-popup">' + innerHtml + '</div>';
  }

  function hopPopupHtml(hop, pathIndex) {
    var lines = [
      '<div class="meshmap-vtrace-popup-title">Path ' + pathIndex +
        ' · hop ' + (hop.hop != null ? hop.hop : '?') + '</div>',
      '<div><span class="meshmap-vtrace-popup-k">Node</span> ' +
        escapeHtml(hopDisplayName(hop)) + '</div>'
    ];
    if (hop.linkType) {
      lines.push('<div><span class="meshmap-vtrace-popup-k">Link</span> ' +
        escapeHtml(hop.linkType) + '</div>');
    }
    lines.push('<div><span class="meshmap-vtrace-popup-k">Delay</span> ' +
      escapeHtml(hopDelayLabel(hop)) + '</div>');
    if (hop.unreachable) {
      lines.push('<div class="meshmap-vtrace-popup-warn">unreachable</div>');
    }
    return wrapVtracePopup(lines.join(''));
  }

  function segmentPopupHtml(path, fromVertex, toVertex, dotted) {
    var hop = toVertex && toVertex.hop ? toVertex.hop : null;
    var lines = [];
    var title = 'Path ' + path.index;
    if (path.count != null && state.doc && state.doc.runs) {
      title += ' (' + path.count + '/' + state.doc.runs + ')';
    }
    if (fromVertex && fromVertex.isSource && hop && hop.hop != null) {
      title += ' · source → hop ' + hop.hop;
    } else if (hop && hop.hop != null) {
      title += ' · hop ' + hop.hop;
    }
    lines.push('<div class="meshmap-vtrace-popup-title">' + escapeHtml(title) + '</div>');
    lines.push('<div><span class="meshmap-vtrace-popup-k">From</span> ' +
      escapeHtml(vertexDisplayName(fromVertex)) + '</div>');
    lines.push('<div><span class="meshmap-vtrace-popup-k">To</span> ' +
      escapeHtml(vertexDisplayName(toVertex)) + '</div>');
    if (hop && hop.linkType) {
      lines.push('<div><span class="meshmap-vtrace-popup-k">Link</span> ' +
        escapeHtml(hop.linkType) + '</div>');
    }
    lines.push('<div><span class="meshmap-vtrace-popup-k">Delay</span> ' +
      escapeHtml(hop ? hopDelayLabel(hop) : '?') + '</div>');
    if (dotted) {
      lines.push('<div class="meshmap-vtrace-popup-warn">via unmapped hop(s)</div>');
    }
    if (path.reached === false) {
      lines.push('<div class="meshmap-vtrace-popup-warn">path unreachable</div>');
    } else if (hop && hop.unreachable) {
      lines.push('<div class="meshmap-vtrace-popup-warn">hop unreachable</div>');
    }
    return wrapVtracePopup(lines.join(''));
  }

  function clearDraw() {
    traceLayer.clearLayers();
  }

  /** Visible paths in draw order (respects path filter). */
  function visiblePaths(doc) {
    var paths = (doc && doc.paths) || [];
    var selected = state.selected;
    return paths.filter(function (path) {
      return selected === 'all' || Number(selected) === Number(path.index);
    });
  }

  /**
   * Lateral pixel offset for a path when several traces share geography.
   * Centered around 0 so 3 paths sit at -spacing, 0, +spacing.
   */
  function pathOffsetPx(path, visible) {
    if (!state.offsetPaths || !visible || visible.length < 2) return 0;
    var idx = -1;
    for (var i = 0; i < visible.length; i++) {
      if (Number(visible[i].index) === Number(path.index)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return 0;
    var spacing = 8;
    return (idx - (visible.length - 1) / 2) * spacing;
  }

  function perpUnit(p1, p2) {
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    // Left-hand normal relative to travel direction.
    return { x: -dy / len, y: dx / len };
  }

  /**
   * Shift a lat/lon polyline sideways in screen space so overlapping
   * multipath colors sit next to each other instead of stacking.
   */
  function offsetPolyline(coords, offsetPx) {
    if (!map || !offsetPx || !coords || coords.length < 2) return coords;
    var pts = coords.map(function (c) {
      return map.latLngToLayerPoint(L.latLng(c[0], c[1]));
    });
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var n1 = i > 0 ? perpUnit(pts[i - 1], pts[i]) : null;
      var n2 = i < pts.length - 1 ? perpUnit(pts[i], pts[i + 1]) : null;
      var nx = 0;
      var ny = 0;
      if (n1 && n2) {
        nx = n1.x + n2.x;
        ny = n1.y + n2.y;
      } else if (n1) {
        nx = n1.x;
        ny = n1.y;
      } else if (n2) {
        nx = n2.x;
        ny = n2.y;
      }
      var nlen = Math.sqrt(nx * nx + ny * ny) || 1;
      nx = (nx / nlen) * offsetPx;
      ny = (ny / nlen) * offsetPx;
      var ll = map.layerPointToLatLng(L.point(pts[i].x + nx, pts[i].y + ny));
      out.push([ll.lat, ll.lng]);
    }
    return out;
  }

  function drawDoc() {
    clearDraw();
    var unresolved = [];
    var doc = state.doc;
    if (!doc || !doc.paths || !doc.paths.length) {
      setStatus(state.status || 'No paths to draw', { skipSave: true });
      renderPathControls();
      return;
    }
    var paths = visiblePaths(doc);
    var src = sourceLatLon(doc);
    var sourceMissing = !src && sourceNameCandidates(doc).length > 0;
    paths.forEach(function (path) {
      var color = pathColor(path.index);
      var offsetPx = pathOffsetPx(path, paths);
      // Build ordered vertices: source first, then hops (so source→hop1 is drawn).
      var vertices = [];
      var hopPopupOpts = (typeof meshmapBindPopupOptions === 'function')
        ? meshmapBindPopupOptions()
        : {};
      if (src) {
        vertices.push({
          lat: src.lat,
          lon: src.lon,
          hop: null,
          known: true,
          isSource: true,
          hostname: src.hostname || src.node || (doc.source || null)
        });
        var srcCircle = L.circleMarker([src.lat, src.lon], {
          radius: 8,
          color: color,
          weight: 2,
          fillColor: color,
          fillOpacity: 0.9,
          opacity: 1
        });
        srcCircle.bindPopup(wrapVtracePopup(
          '<div class="meshmap-vtrace-popup-title">Source</div>' +
          '<div>' + escapeHtml(src.hostname || src.node || doc.source || 'source') + '</div>'
        ), hopPopupOpts);
        traceLayer.addLayer(srcCircle);
      }
      (path.hops || []).forEach(function (hop) {
        var pos = resolveHopLatLon(hop);
        if (!pos) {
          unresolved.push((hop.hostname || hop.ip || '*') + ' (path ' + path.index + ')');
          vertices.push({ lat: null, lon: null, hop: hop, known: false });
          return;
        }
        // Only collapse hop1 into source when it is the same node — not when a
        // DtD/RF neighbor shares the tower GPS (that still needs source→hop1).
        if (src && vertices.length === 1 && vertices[0].isSource) {
          var srcKey = nodeKey(vertices[0].hostname || doc.source);
          var hopKey = nodeKey(hop.hostname);
          if (srcKey && hopKey && srcKey === hopKey) {
            vertices[0].hop = hop;
            return;
          }
        }
        vertices.push({ lat: pos.lat, lon: pos.lon, hop: hop, known: true });
        var circle = L.circleMarker([pos.lat, pos.lon], {
          radius: 6,
          color: color,
          weight: 2,
          fillColor: '#fff',
          fillOpacity: 0.95,
          opacity: 1
        });
        circle.bindPopup(hopPopupHtml(hop, path.index), hopPopupOpts);
        traceLayer.addLayer(circle);
      });
      drawPathSegments(vertices, color, path, offsetPx);
    });
    bringTraceToFront();
    applyMapLinkOverlayState();
    var msg = (doc.tool || 'trace') + ': ' + (doc.paths.length) + ' path(s)';
    if (doc.destination) msg += ' → ' + doc.destination;
    if (src) {
      msg += ' · from ' + (src.hostname || src.node || doc.source);
    } else if (sourceMissing) {
      msg += ' · source not on map (no link to hop 1)';
    }
    if (unresolved.length) {
      msg += ' · unresolved: ' + unresolved.slice(0, 6).join(', ') +
        (unresolved.length > 6 ? '…' : '');
    }
    setStatus(msg, { skipSave: true });
    renderPathControls();
  }

  /** LatLngs for all mappable hops in currently visible path(s), plus source. */
  function collectTraceLatLngs(doc) {
    var pts = [];
    var seen = {};
    function add(lat, lon) {
      if (lat == null || lon == null || !isFinite(Number(lat)) || !isFinite(Number(lon))) return;
      var key = Number(lat).toFixed(5) + ',' + Number(lon).toFixed(5);
      if (seen[key]) return;
      seen[key] = true;
      pts.push(L.latLng(Number(lat), Number(lon)));
    }
    if (!doc) return pts;
    var src = sourceLatLon(doc);
    if (src) add(src.lat, src.lon);
    visiblePaths(doc).forEach(function (path) {
      (path.hops || []).forEach(function (hop) {
        var pos = resolveHopLatLon(hop);
        if (pos) add(pos.lat, pos.lon);
      });
    });
    return pts;
  }

  function fitMapToTrace() {
    if (!state.autoCenter || !map || !state.doc) return;
    var pts = collectTraceLatLngs(state.doc);
    if (!pts.length) return;
    if (pts.length === 1) {
      map.setView(pts[0], Math.max(map.getZoom(), 12));
      return;
    }
    try {
      map.fitBounds(L.latLngBounds(pts), {
        padding: [48, 48],
        maxZoom: 14,
        animate: true
      });
    } catch (err) {
      /* ignore invalid bounds */
    }
  }

  /**
   * Draw solid segments between consecutive known hops; when unknowns sit
   * between two known hops, draw a dotted chord so the path still looks complete.
   */
  function hopDelayLabel(hop) {
    if (!hop) return '?';
    var avg = hop.rttAvgMs != null ? hop.rttAvgMs : hop.rttMs;
    if (avg == null || !isFinite(Number(avg))) return '?';
    var avgStr = Math.round(Number(avg)) + 'ms';
    if (hop.rttDevMs != null && isFinite(Number(hop.rttDevMs))) {
      return avgStr + ' \u00b1 ' + Math.round(Number(hop.rttDevMs)) + 'ms';
    }
    return avgStr;
  }

  function hopLabelText(hop) {
    if (!hop || (!state.showHop && !state.showDelay)) return '';
    var hopNum = hop.hop != null ? String(hop.hop) : '?';
    if (state.showHop && state.showDelay) return hopNum + ' : ' + hopDelayLabel(hop);
    if (state.showHop) return hopNum;
    return hopDelayLabel(hop);
  }

  function addHopLabel(latlng, text, color) {
    if (!text || !latlng) return;
    var icon = L.divIcon({
      className: 'meshmap-vtrace-hop-label',
      html: '<span style="border-color:' + color + ';">' + escapeHtml(text) + '</span>',
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    });
    var marker = L.marker(latlng, {
      icon: icon,
      interactive: false,
      keyboard: false,
      zIndexOffset: 400
    });
    traceLayer.addLayer(marker);
  }

  function drawHopLabels(vertices, color, offsetPx) {
    if (!state.showHop && !state.showDelay) return;
    var lastKnown = null;
    vertices.forEach(function (v) {
      if (!v.known) return;
      // Label the inbound link to this hop (including source → hop 1).
      if (lastKnown && v.hop && !(lastKnown.isSource && lastKnown.hop === v.hop)) {
        var text = hopLabelText(v.hop);
        if (text) {
          var drawn = offsetPolyline(
            ensureVisibleSegment([[lastKnown.lat, lastKnown.lon], [v.lat, v.lon]]),
            offsetPx || 0
          );
          if (drawn && drawn.length >= 2) {
            var a = drawn[0];
            var b = drawn[drawn.length - 1];
            addHopLabel(L.latLng((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), text, color);
          }
        }
      }
      lastKnown = v;
    });
  }

  function drawPathSegments(vertices, color, path, offsetPx) {
    // One polyline per hop link so click popups can show that segment's from/to/delay.
    var lastKnown = null;
    var pendingGap = false;
    vertices.forEach(function (v) {
      if (!v.known) {
        pendingGap = true;
        return;
      }
      if (lastKnown) {
        addPathLine(
          [[lastKnown.lat, lastKnown.lon], [v.lat, v.lon]],
          color,
          path,
          pendingGap,
          offsetPx,
          lastKnown,
          v
        );
        pendingGap = false;
      }
      lastKnown = v;
    });
    drawHopLabels(vertices, color, offsetPx);
  }

  /** Keep a short stub visible when two hops share GPS (same-tower DtD). */
  function ensureVisibleSegment(coords) {
    if (!map || !coords || coords.length < 2) return coords;
    var a = coords[0];
    var b = coords[coords.length - 1];
    if (!a || !b) return coords;
    var p1 = map.latLngToLayerPoint(L.latLng(a[0], a[1]));
    var p2 = map.latLngToLayerPoint(L.latLng(b[0], b[1]));
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    if (Math.sqrt(dx * dx + dy * dy) >= 6) return coords;
    var ll = map.layerPointToLatLng(L.point(p2.x + 12, p2.y - 12));
    var out = coords.slice();
    out[out.length - 1] = [ll.lat, ll.lng];
    return out;
  }

  function addPathLine(coords, color, path, dotted, offsetPx, fromVertex, toVertex) {
    if (!coords || coords.length < 2) return;
    var drawn = offsetPolyline(ensureVisibleSegment(coords), offsetPx || 0);
    var opts = {
      color: color,
      weight: dotted ? 4 : 5,
      opacity: dotted ? 0.75 : 0.9,
      lineJoin: 'round',
      interactive: true
    };
    if (dotted) {
      opts.dashArray = '2, 10';
    }
    var line = L.polyline(drawn, opts);
    var popupOpts = (typeof meshmapBindPopupOptions === 'function')
      ? meshmapBindPopupOptions()
      : {};
    line.bindPopup(segmentPopupHtml(path, fromVertex, toVertex, dotted), popupOpts);
    traceLayer.addLayer(line);
  }

  function setStatus(msg, opts) {
    opts = opts || {};
    state.status = msg || '';
    if (control && control._status) {
      control._status.textContent = state.status;
    }
    if (!opts.skipSave) saveSession();
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

  function allLinkLayers() {
    return [
      window.twoLinksTX, window.twoLinksThp, window.twoLinksSnR, window.twoLinksCost, window.twoLinksQual,
      window.threeLinksTX, window.threeLinksThp, window.threeLinksSnR, window.threeLinksCost, window.threeLinksQual,
      window.fiveLinksTX, window.fiveLinksThp, window.fiveLinksSnR, window.fiveLinksCost, window.fiveLinksQual,
      window.nineLinksTX, window.nineLinksThp, window.nineLinksSnR, window.nineLinksCost, window.nineLinksQual,
      window.noRFLinks, window.superNodeLinks
    ].filter(Boolean);
  }

  function hasActiveTrace() {
    return !!(state.doc && state.doc.paths && state.doc.paths.length &&
      map && map.hasLayer(traceLayer));
  }

  /**
   * While a visual traceroute is on the map, mesh RF/DtD links must not steal
   * clicks (their "node — node" popups). Visibility still follows Hide map links.
   */
  function applyMapLinkOverlayState() {
    var active = hasActiveTrace();
    var hideVisually = !!(state.hideLinks && active);
    allLinkLayers().forEach(function (layer) {
      if (!layer || typeof layer.eachLayer !== 'function') return;
      layer.eachLayer(function (line) {
        if (!line || !line.options || typeof line.setStyle !== 'function') return;
        if (line.options.meshmapBaseOpacity === undefined) {
          line.options.meshmapBaseOpacity =
            line.options.opacity != null ? line.options.opacity : 0.8;
        }
        line.setStyle({
          opacity: hideVisually ? 0 : line.options.meshmapBaseOpacity,
          interactive: !active
        });
      });
    });
  }

  function restoreMapLinkClicks() {
    allLinkLayers().forEach(function (layer) {
      if (!layer || typeof layer.eachLayer !== 'function') return;
      layer.eachLayer(function (line) {
        if (!line || !line.options || typeof line.setStyle !== 'function') return;
        if (line.options.meshmapBaseOpacity === undefined) {
          line.options.meshmapBaseOpacity =
            line.options.opacity != null ? line.options.opacity : 0.8;
        }
        line.setStyle({
          opacity: line.options.meshmapBaseOpacity,
          interactive: true
        });
      });
    });
  }

  function applyHideLinks() {
    applyMapLinkOverlayState();
  }

  function bringTraceToFront() {
    if (!traceLayer || typeof traceLayer.eachLayer !== 'function') return;
    traceLayer.eachLayer(function (layer) {
      if (layer && typeof layer.bringToFront === 'function') {
        layer.bringToFront();
      }
    });
  }

  function formatHopText(hop) {
    if (!hop || hop.unreachable) {
      return (hop && hop.hop != null ? hop.hop : '?') + ' *';
    }
    var label = hop.hostname || hop.ip || '*';
    if (hop.hostname && hop.ip && hop.hostname !== hop.ip) {
      label = hop.hostname + ' (' + hop.ip + ')';
    } else if (hop.ip && !hop.hostname) {
      label = hop.ip;
    }
    var bits = [String(hop.hop), label];
    if (hop.linkType) bits.push(hop.linkType);
    if (hop.rttAvgMs != null) {
      bits.push('avg ' + hop.rttAvgMs + 'ms' +
        (hop.rttDevMs != null ? ' \u00b1 ' + hop.rttDevMs + 'ms' : ''));
    } else if (hop.rttMs != null) {
      bits.push(hop.rttMs + ' ms');
    }
    return bits.join(' ');
  }

  function formatPathHeader(doc, path) {
    var header = 'Path ' + path.index + ': ' +
      (path.count != null && doc.runs ? path.count + '/' + doc.runs : String(path.count || ''));
    if (path.reached === false) header += '  [unreachable]';
    return header;
  }

  function formatDocAsText(doc) {
    if (!doc) return '';
    var lines = [];
    var tool = doc.tool || 'trace';
    if (tool === 'stableroute') {
      lines.push('stableroute' + (doc.version ? '(' + doc.version + ')' : '') +
        ': destination ' + (doc.destination || '?') +
        '  runs ' + (doc.runs != null ? doc.runs : '?'));
      if (doc.using) lines.push(String(doc.using));
      if (doc.source) lines.push('source ' + doc.source);
      var sum = doc.summary || {};
      lines.push('Summary:');
      lines.push('  unique paths: ' + (sum.uniquePaths != null ? sum.uniquePaths : (doc.paths || []).length));
      if (sum.shortest != null) lines.push('  shortest route: ' + sum.shortest + ' hops');
      if (sum.longest != null) lines.push('  longest route: ' + sum.longest + ' hops');
      if (sum.unreachable != null) lines.push('  Unreachable: ' + sum.unreachable);
      if (sum.mostCommonCount != null && doc.runs) {
        var pct = doc.runs ? Math.round((sum.mostCommonCount * 100) / doc.runs) : 0;
        lines.push('  most common: ' + sum.mostCommonCount + '/' + doc.runs + ' (' + pct + '%)');
      }
      lines.push('');
      (doc.paths || []).forEach(function (path) {
        lines.push('-------------------------------------------------');
        lines.push(formatPathHeader(doc, path));
        (path.hops || []).forEach(function (hop) {
          lines.push('  ' + formatHopText(hop));
        });
        lines.push('');
      });
    } else {
      lines.push('traceroute to ' + (doc.destination || '?') +
        (doc.source ? ' (from ' + doc.source + ')' : ''));
      if (doc.version) lines.push('Aredn-Traceroute(' + doc.version + ')');
      if (doc.babelMetric != null) lines.push('Babel Metric ' + doc.babelMetric);
      var path0 = (doc.paths && doc.paths[0]) || { hops: [] };
      (path0.hops || []).forEach(function (hop) {
        lines.push(' ' + formatHopText(hop));
      });
    }
    return lines.join('\n').replace(/\n+$/, '') + '\n';
  }

  function formatStablerouteIntro(doc) {
    var lines = [];
    lines.push('stableroute' + (doc.version ? '(' + doc.version + ')' : '') +
      ': destination ' + (doc.destination || '?') +
      '  runs ' + (doc.runs != null ? doc.runs : '?'));
    if (doc.using) lines.push(String(doc.using));
    if (doc.source) lines.push('source ' + doc.source);
    var sum = doc.summary || {};
    lines.push('Summary:');
    lines.push('  unique paths: ' + (sum.uniquePaths != null ? sum.uniquePaths : (doc.paths || []).length));
    if (sum.shortest != null) lines.push('  shortest route: ' + sum.shortest + ' hops');
    if (sum.longest != null) lines.push('  longest route: ' + sum.longest + ' hops');
    if (sum.unreachable != null) lines.push('  Unreachable: ' + sum.unreachable);
    if (sum.mostCommonCount != null && doc.runs) {
      var pct = doc.runs ? Math.round((sum.mostCommonCount * 100) / doc.runs) : 0;
      lines.push('  most common: ' + sum.mostCommonCount + '/' + doc.runs + ' (' + pct + '%)');
    }
    return lines.join('\n');
  }

  function formatPathBlockText(doc, path) {
    var lines = [formatPathHeader(doc, path)];
    (path.hops || []).forEach(function (hop) {
      lines.push('  ' + formatHopText(hop));
    });
    return lines.join('\n');
  }

  /** Colored path blocks for the Trace report console (Copy still uses plain text). */
  function renderConsoleHtml(doc) {
    if (!doc || !doc.paths || !doc.paths.length) {
      return '<pre class="meshmap-vtrace-console-plain">(no report loaded)</pre>';
    }
    var tool = doc.tool || 'trace';
    var html = [];
    if (tool === 'stableroute') {
      html.push('<pre class="meshmap-vtrace-console-plain">' +
        escapeHtml(formatStablerouteIntro(doc)) + '</pre>');
      doc.paths.forEach(function (path) {
        var color = pathColor(path.index);
        html.push(
          '<div class="meshmap-vtrace-console-path" style="--vtrace-path-color:' +
            color + '; border-left-color:' + color + ';">' +
          '<pre>' + escapeHtml(formatPathBlockText(doc, path)) + '</pre>' +
          '</div>'
        );
      });
    } else {
      var color0 = pathColor(1);
      var lines = [];
      lines.push('traceroute to ' + (doc.destination || '?') +
        (doc.source ? ' (from ' + doc.source + ')' : ''));
      if (doc.version) lines.push('Aredn-Traceroute(' + doc.version + ')');
      if (doc.babelMetric != null) lines.push('Babel Metric ' + doc.babelMetric);
      var path0 = doc.paths[0] || { hops: [], index: 1 };
      (path0.hops || []).forEach(function (hop) {
        lines.push(' ' + formatHopText(hop));
      });
      html.push(
        '<div class="meshmap-vtrace-console-path" style="--vtrace-path-color:' +
          color0 + '; border-left-color:' + color0 + ';">' +
        '<pre>' + escapeHtml(lines.join('\n')) + '</pre></div>'
      );
    }
    return html.join('');
  }

  function updateConsole() {
    if (!control || !control._consoleBody) return;
    var hasDoc = !!(state.doc && state.doc.paths && state.doc.paths.length);
    var text = state.rawText || formatDocAsText(state.doc) || '';
    if (hasDoc) {
      control._consoleBody.innerHTML = renderConsoleHtml(state.doc);
    } else if (text) {
      control._consoleBody.innerHTML =
        '<pre class="meshmap-vtrace-console-plain">' + escapeHtml(text) + '</pre>';
    } else {
      control._consoleBody.innerHTML =
        '<pre class="meshmap-vtrace-console-plain">(no report loaded)</pre>';
    }
    if (control._console) {
      if ((hasDoc || text) && !state.consoleMinimized) {
        L.DomUtil.addClass(control._console, 'meshmap-vtrace-console-open');
        L.DomUtil.removeClass(control._console, 'meshmap-vtrace-console-min');
      } else if ((hasDoc || text) && state.consoleMinimized) {
        L.DomUtil.addClass(control._console, 'meshmap-vtrace-console-open');
        L.DomUtil.addClass(control._console, 'meshmap-vtrace-console-min');
      } else if (!hasDoc && !text) {
        L.DomUtil.removeClass(control._console, 'meshmap-vtrace-console-open');
        L.DomUtil.removeClass(control._console, 'meshmap-vtrace-console-min');
      }
      if (control._consoleToggle) {
        control._consoleToggle.textContent = state.consoleMinimized ? 'Show' : 'Minimize';
        control._consoleToggle.setAttribute('aria-expanded', state.consoleMinimized ? 'false' : 'true');
      }
    }
  }

  function applyDoc(doc, rawText, opts) {
    opts = opts || {};
    state.doc = doc;
    // Prefer an explicit source so source→hop1 can be drawn on the map.
    if (doc && !doc.source && control && control._form && control._form.sourceIn) {
      var formSrc = control._form.sourceIn.value.trim();
      if (formSrc) doc.source = nodeKey(formSrc);
    }
    if (rawText != null && String(rawText).trim()) {
      state.rawText = String(rawText);
    } else {
      state.rawText = formatDocAsText(doc);
    }
    if (!opts.keepSelected) {
      state.selected = 'all';
    }
    if (!opts.keepConsole) {
      state.consoleMinimized = false;
    }
    ensureLayerOn();
    applyHideLinks();
    drawDoc();
    updateConsole();
    renderPathControls();
    if (!opts.skipFit) fitMapToTrace();
    if (!opts.skipSave) saveSession();
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
    // "All paths" only when multipath; single-path runs skip the redundant choice.
    if (doc.paths.length >= 2) {
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
        fitMapToTrace();
        saveSession();
      });
      allLabel.appendChild(allRadio);
      allLabel.appendChild(document.createTextNode(' All paths'));
      box.appendChild(allLabel);
    } else if (state.selected === 'all' && doc.paths[0]) {
      state.selected = doc.paths[0].index;
    }

    doc.paths.forEach(function (path) {
      var label = document.createElement('label');
      label.className = 'meshmap-vtrace-path';
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'meshmap-vtrace-path';
      radio.value = String(path.index);
      radio.checked = state.selected === 'all'
        ? doc.paths.length === 1
        : Number(state.selected) === Number(path.index);
      radio.addEventListener('change', function () {
        state.selected = path.index;
        drawDoc();
        fitMapToTrace();
        saveSession();
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
    if (control && control._directBtn) {
      control._directBtn.disabled = state.busy;
    }
  }

  function formatElapsed(ms) {
    var sec = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m ? (m + ':' + (s < 10 ? '0' : '') + s) : (s + 's');
  }

  function setProgressUI(opts) {
    opts = opts || {};
    if (!control || !control._progress) return;
    var wrap = control._progress;
    var labelEl = control._progressLabel;
    var barEl = control._progressBar;
    var trackEl = control._progressTrack;
    if (!opts.show) {
      wrap.hidden = true;
      L.DomUtil.removeClass(wrap, 'meshmap-vtrace-progress-indeterminate');
      if (barEl) barEl.style.width = '0%';
      return;
    }
    wrap.hidden = false;
    if (labelEl) labelEl.textContent = opts.label || '';
    if (opts.pct == null || !isFinite(opts.pct)) {
      L.DomUtil.addClass(wrap, 'meshmap-vtrace-progress-indeterminate');
      if (barEl) barEl.style.width = '100%';
      if (trackEl) trackEl.setAttribute('aria-valuenow', '0');
    } else {
      L.DomUtil.removeClass(wrap, 'meshmap-vtrace-progress-indeterminate');
      var pct = Math.max(0, Math.min(100, Math.round(opts.pct)));
      if (barEl) barEl.style.width = pct + '%';
      if (trackEl) {
        trackEl.setAttribute('aria-valuenow', String(pct));
      }
    }
  }

  function stopProgress() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    setProgressUI({ show: false });
  }

  function startProgress(opts) {
    opts = opts || {};
    stopProgress();
    progressStartedAt = Date.now();
    var tool = opts.tool || 'trace';
    var n = opts.n || 1;
    var direct = !!opts.direct;
    var where = direct ? 'on node' : 'via meshinfo';
    var lastRun = null;
    var lastTotal = n;

    function tick(extra) {
      if (extra && extra.run != null) lastRun = extra.run;
      if (extra && extra.total != null) lastTotal = extra.total;
      var elapsed = formatElapsed(Date.now() - progressStartedAt);
      var label;
      var pct = null;
      if (tool === 'stableroute') {
        if (lastRun != null && lastRun > 0) {
          // Partially fill the current run slot so the bar keeps moving between hops.
          pct = Math.max(1, Math.min(99, Math.round((100 * (lastRun - 0.15)) /
            Math.max(1, lastTotal))));
          label = 'stableroute ' + where + ' · run ' + lastRun + '/' + lastTotal +
            ' · ' + elapsed;
        } else if (!direct) {
          // Meshinfo buffers until done — soft estimate (~8s/run), never 100% until finish.
          var soft = Math.min(92, Math.round((100 * ((Date.now() - progressStartedAt) / 1000)) /
            Math.max(8, n * 8)));
          pct = soft;
          label = 'stableroute ' + where + ' · ' + n + ' run' + (n === 1 ? '' : 's') +
            ' · ' + elapsed;
        } else {
          label = 'stableroute ' + where + ' · starting · ' + elapsed;
          pct = 2;
        }
      } else {
        label = 'traceroute ' + where + ' · ' + elapsed;
        pct = null;
      }
      if (extra && extra.detail) {
        label += ' · ' + extra.detail;
      }
      setProgressUI({ show: true, label: label, pct: pct });
      setStatus(label, { skipSave: true });
    }

    tick(null);
    progressTimer = setInterval(function () { tick(null); }, 500);
    return {
      updateRun: function (run, total) {
        tick({ run: run, total: total });
      },
      tick: tick
    };
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
    if (!payload || !Array.isArray(payload.paths) || !payload.paths.length) {
      throw new Error((payload && payload.error) || 'meshinfo returned no paths');
    }
    return payload;
  }

  function stripHtmlPre(text) {
    var s = String(text || '');
    var m = s.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (m) s = m[1];
    return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&#x26;/g, '&').replace(/&nbsp;/g, ' ');
  }

  function parseNodeTraceBody(tool, text, destination) {
    var body = stripHtmlPre(text).trim();
    if (!body) {
      throw new Error(tool + ' returned empty body');
    }
    var doc;
    if (body.charAt(0) === '{') {
      doc = JSON.parse(body);
    } else if (tool === 'stableroute') {
      doc = parseStablerouteText(body);
      if (destination && !doc.destination) {
        doc.destination = nodeKey(destination);
      }
    } else {
      doc = parseTracerouteText(body);
      if (destination && !doc.destination) {
        doc.destination = nodeKey(destination);
      }
    }
    if (!doc || !Array.isArray(doc.paths) || !doc.paths.length) {
      throw new Error(tool + ' returned no paths');
    }
    return doc;
  }

  function nodeCgiUrl(host, tool, destination, n, wantJson) {
    var qs = 'server=' + encodeURIComponent(destination);
    if (wantJson) qs += '&format=json';
    if (tool === 'stableroute') {
      qs += '&n=' + encodeURIComponent(String(n || 5));
    }
    var path = tool === 'stableroute' ? '/cgi-bin/stableroute' : '/cgi-bin/traceroute';
    return 'http://' + host + path + '?' + qs;
  }

  async function fetchNodeCgi(host, tool, destination, n, wantJson) {
    var resp = await fetch(nodeCgiUrl(host, tool, destination, n, wantJson));
    var text = await resp.text();
    if (!resp.ok) {
      throw new Error('node CGI HTTP ' + resp.status);
    }
    return text;
  }

  /**
   * Stream stableroute text CGI so "run X/Y" lines update the progress bar live.
   * JSON mode buffers until done and uses -noprogress, so text is preferred here.
   */
  async function fetchStablerouteStreaming(host, destination, n, onProgress) {
    var resp = await fetch(nodeCgiUrl(host, 'stableroute', destination, n, false));
    if (!resp.ok) {
      throw new Error('node CGI HTTP ' + resp.status);
    }
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      var all = await resp.text();
      return all;
    }
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var full = '';
    var buf = '';
    var lastRun = 0;
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      var piece = decoder.decode(chunk.value, { stream: true });
      full += piece;
      buf += piece;
      var parts = buf.split(/\r?\n/);
      buf = parts.pop() || '';
      parts.forEach(function (raw) {
        var line = String(raw || '').replace(/<[^>]+>/g, '').trim();
        if (!line || line.indexOf('__sr_ka__') >= 0) return;
        var m = line.match(/^run\s+(\d+)\s*\/\s*(\d+)/i);
        if (m) {
          var run = parseInt(m[1], 10);
          var total = parseInt(m[2], 10);
          if (run !== lastRun) {
            lastRun = run;
            if (typeof onProgress === 'function') onProgress(run, total);
          }
          return;
        }
        var p = line.match(/^probing\s+(\d+)\s+runs?/i);
        if (p && typeof onProgress === 'function') {
          onProgress(0, parseInt(p[1], 10) || n);
        }
      });
    }
    if (buf) full += buf;
    return full;
  }

  async function runDirect(tool, source, destination, n, progress) {
    var host = nodeKey(source) + '.local.mesh';
    var text;
    var doc;
    if (tool === 'stableroute') {
      text = await fetchStablerouteStreaming(host, destination, n, function (run, total) {
        if (progress && progress.updateRun) progress.updateRun(Math.max(1, run), total || n);
      });
      doc = parseNodeTraceBody(tool, text, destination);
    } else {
      text = await fetchNodeCgi(host, tool, destination, n, true);
      try {
        doc = parseNodeTraceBody(tool, text, destination);
      } catch (primaryErr) {
        text = await fetchNodeCgi(host, tool, destination, n, false);
        try {
          doc = parseNodeTraceBody(tool, text, destination);
        } catch (fallbackErr) {
          throw new Error(String(primaryErr.message || primaryErr) +
            ' (text fallback: ' + String(fallbackErr.message || fallbackErr) + ')');
        }
      }
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

        // Floating overlay on the map (not docked to the control) so it can drag.
        var panel = L.DomUtil.create('div', 'meshmap-vtrace-panel', map.getContainer());
        panel.innerHTML =
          '<div class="meshmap-vtrace-header meshmap-vtrace-drag-handle" title="Drag to move">' +
          '<span class="meshmap-vtrace-header-title">Visual Traceroute</span>' +
          '<button type="button" class="meshmap-vtrace-panel-close" title="Close" aria-label="Close">×</button>' +
          '</div>' +
          '<div class="meshmap-vtrace-tabs" role="tablist">' +
          '<button type="button" class="meshmap-vtrace-tab" data-tab="paste" role="tab" aria-selected="true">Paste</button>' +
          '<button type="button" class="meshmap-vtrace-tab" data-tab="live" role="tab" aria-selected="false">Live</button>' +
          '</div>' +
          '<div class="meshmap-vtrace-tabpanel" data-tabpanel="paste" role="tabpanel">' +
          '<label class="meshmap-vtrace-field">Paste report (JSON or text)' +
          '<textarea class="meshmap-vtrace-paste" rows="5" spellcheck="false" ' +
          'placeholder="Paste aredn-traceroute / stableroute output or JSON"></textarea></label>' +
          '<div class="meshmap-vtrace-row">' +
          '<button type="button" class="meshmap-vtrace-parse">Parse / Draw</button>' +
          '<button type="button" class="meshmap-vtrace-clear">Clear</button>' +
          '</div>' +
          '</div>' +
          '<div class="meshmap-vtrace-tabpanel" data-tabpanel="live" role="tabpanel" hidden>' +
          '<label class="meshmap-vtrace-field">Tool' +
          '<select class="meshmap-vtrace-tool">' +
          '<option value="traceroute">traceroute</option>' +
          '<option value="stableroute">stableroute</option>' +
          '</select></label>' +
          '<label class="meshmap-vtrace-field">Source' +
          '<input list="meshmap-vtrace-nodes" class="meshmap-vtrace-source" autocomplete="off"></label>' +
          '<label class="meshmap-vtrace-field">Destination' +
          '<input list="meshmap-vtrace-nodes" class="meshmap-vtrace-dest" autocomplete="off"></label>' +
          '<label class="meshmap-vtrace-field meshmap-vtrace-n-wrap" hidden>Runs (stableroute)' +
          '<input type="number" class="meshmap-vtrace-n" min="1" max="20" value="5"></label>' +
          '<datalist id="meshmap-vtrace-nodes"></datalist>' +
          '<div class="meshmap-vtrace-row">' +
          '<button type="button" class="meshmap-vtrace-direct" hidden>Run</button>' +
          '<button type="button" class="meshmap-vtrace-clear-live">Clear</button>' +
          '</div>' +
          '<div class="meshmap-vtrace-progress" hidden>' +
          '<div class="meshmap-vtrace-progress-label"></div>' +
          '<div class="meshmap-vtrace-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
          '<div class="meshmap-vtrace-progress-bar"></div>' +
          '</div></div>' +
          '</div>' +
          '<div class="meshmap-vtrace-options' + (state.optionsMinimized ? ' meshmap-vtrace-options-min' : '') + '">' +
          '<button type="button" class="meshmap-vtrace-options-toggle" aria-expanded="' +
          (state.optionsMinimized ? 'false' : 'true') + '">' +
          '<span class="meshmap-vtrace-options-caret" aria-hidden="true"></span>' +
          'Options</button>' +
          '<div class="meshmap-vtrace-options-body">' +
          '<label class="meshmap-vtrace-check">' +
          '<input type="checkbox" class="meshmap-vtrace-hide-links"> Hide map links while tracing</label>' +
          '<label class="meshmap-vtrace-check">' +
          '<input type="checkbox" class="meshmap-vtrace-offset-paths"> Offset overlapping paths</label>' +
          '<label class="meshmap-vtrace-check">' +
          '<input type="checkbox" class="meshmap-vtrace-auto-center"> Auto center map</label>' +
          '<label class="meshmap-vtrace-check">' +
          '<input type="checkbox" class="meshmap-vtrace-show-hop"> Show Hop</label>' +
          '<label class="meshmap-vtrace-check">' +
          '<input type="checkbox" class="meshmap-vtrace-show-delay"> Show Delay</label>' +
          '</div></div>' +
          '<div class="meshmap-vtrace-subheader">Paths</div>' +
          '<div class="meshmap-vtrace-paths"></div>' +
          '<div class="meshmap-vtrace-status"></div>';

        var consoleEl = L.DomUtil.create('div', 'meshmap-vtrace-console', map.getContainer());
        consoleEl.innerHTML =
          '<div class="meshmap-vtrace-console-bar meshmap-vtrace-drag-handle" title="Drag to move">' +
          '<span class="meshmap-vtrace-console-title">Trace report</span>' +
          '<span class="meshmap-vtrace-console-actions">' +
          '<button type="button" class="meshmap-vtrace-console-copy">Copy</button>' +
          '<button type="button" class="meshmap-vtrace-console-toggle" aria-expanded="true">Minimize</button>' +
          '</span>' +
          '</div>' +
          '<div class="meshmap-vtrace-console-body">' +
          '<pre class="meshmap-vtrace-console-plain">(no report loaded)</pre></div>';

        var paste = panel.querySelector('.meshmap-vtrace-paste');
        var parseBtn = panel.querySelector('.meshmap-vtrace-parse');
        var clearBtn = panel.querySelector('.meshmap-vtrace-clear');
        var clearLiveBtn = panel.querySelector('.meshmap-vtrace-clear-live');
        var panelCloseBtn = panel.querySelector('.meshmap-vtrace-panel-close');
        var panelHeader = panel.querySelector('.meshmap-vtrace-header');
        var toolSel = panel.querySelector('.meshmap-vtrace-tool');
        var sourceIn = panel.querySelector('.meshmap-vtrace-source');
        var destIn = panel.querySelector('.meshmap-vtrace-dest');
        var nWrap = panel.querySelector('.meshmap-vtrace-n-wrap');
        var nIn = panel.querySelector('.meshmap-vtrace-n');
        var directBtn = panel.querySelector('.meshmap-vtrace-direct');
        var hideLinksCb = panel.querySelector('.meshmap-vtrace-hide-links');
        var offsetPathsCb = panel.querySelector('.meshmap-vtrace-offset-paths');
        var autoCenterCb = panel.querySelector('.meshmap-vtrace-auto-center');
        var showHopCb = panel.querySelector('.meshmap-vtrace-show-hop');
        var showDelayCb = panel.querySelector('.meshmap-vtrace-show-delay');
        var progressWrap = panel.querySelector('.meshmap-vtrace-progress');
        var progressLabel = panel.querySelector('.meshmap-vtrace-progress-label');
        var progressTrack = panel.querySelector('.meshmap-vtrace-progress-track');
        var progressBar = panel.querySelector('.meshmap-vtrace-progress-bar');
        var pathsBox = panel.querySelector('.meshmap-vtrace-paths');
        var statusEl = panel.querySelector('.meshmap-vtrace-status');
        var list = panel.querySelector('#meshmap-vtrace-nodes');
        var tabBtns = panel.querySelectorAll('.meshmap-vtrace-tab');
        var tabPanels = panel.querySelectorAll('.meshmap-vtrace-tabpanel');
        var optionsBox = panel.querySelector('.meshmap-vtrace-options');
        var optionsToggle = panel.querySelector('.meshmap-vtrace-options-toggle');
        var consoleBar = consoleEl.querySelector('.meshmap-vtrace-console-bar');
        var consoleToggle = consoleEl.querySelector('.meshmap-vtrace-console-toggle');
        var consoleCopy = consoleEl.querySelector('.meshmap-vtrace-console-copy');
        var consoleBody = consoleEl.querySelector('.meshmap-vtrace-console-body');

        if (isCompactUi() && paste) {
          paste.rows = 3;
        }

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
          if (state.modeTab !== 'paste' && state.modeTab !== 'live') {
            state.modeTab = 'live';
          }
        }

        this._panel = panel;
        this._status = statusEl;
        this._paths = pathsBox;
        this._directBtn = directBtn;
        this._progress = progressWrap;
        this._progressLabel = progressLabel;
        this._progressTrack = progressTrack;
        this._progressBar = progressBar;
        this._console = consoleEl;
        this._consoleBody = consoleBody;
        this._consoleToggle = consoleToggle;
        this._togglePanel = function (open, opts) { togglePanel(open, opts); };
        this._setModeTab = setModeTab;
        this._setOptionsMinimized = setOptionsMinimized;
        this._form = {
          paste: paste,
          toolSel: toolSel,
          sourceIn: sourceIn,
          destIn: destIn,
          nIn: nIn,
          nWrap: nWrap,
          hideLinksCb: hideLinksCb,
          offsetPathsCb: offsetPathsCb,
          autoCenterCb: autoCenterCb,
          showHopCb: showHopCb,
          showDelayCb: showDelayCb
        };

        function syncRunsVisibility() {
          nWrap.hidden = toolSel.value !== 'stableroute';
        }
        syncRunsVisibility();

        function setModeTab(tab, opts) {
          opts = opts || {};
          var next = tab === 'live' ? 'live' : 'paste';
          state.modeTab = next;
          for (var i = 0; i < tabBtns.length; i++) {
            var active = tabBtns[i].getAttribute('data-tab') === next;
            tabBtns[i].setAttribute('aria-selected', active ? 'true' : 'false');
            if (active) {
              L.DomUtil.addClass(tabBtns[i], 'meshmap-vtrace-tab-active');
            } else {
              L.DomUtil.removeClass(tabBtns[i], 'meshmap-vtrace-tab-active');
            }
          }
          for (var j = 0; j < tabPanels.length; j++) {
            tabPanels[j].hidden = tabPanels[j].getAttribute('data-tabpanel') !== next;
          }
          if (!opts.skipSave) saveSession();
        }

        function setOptionsMinimized(min, opts) {
          opts = opts || {};
          state.optionsMinimized = !!min;
          if (state.optionsMinimized) {
            L.DomUtil.addClass(optionsBox, 'meshmap-vtrace-options-min');
          } else {
            L.DomUtil.removeClass(optionsBox, 'meshmap-vtrace-options-min');
          }
          optionsToggle.setAttribute('aria-expanded', state.optionsMinimized ? 'false' : 'true');
          if (!opts.skipSave) saveSession();
        }

        // Default: Live on mesh hosts when no saved tab yet (restore may override).
        setModeTab(onMeshHost() ? 'live' : 'paste', { skipSave: true });
        setOptionsMinimized(true, { skipSave: true });

        function togglePanel(open, opts) {
          opts = opts || {};
          state.panelOpen = !!open;
          if (open) {
            L.DomUtil.addClass(root, 'meshmap-vtrace-expanded');
            L.DomUtil.addClass(panel, 'meshmap-vtrace-panel-open');
            applyFloatingPos(panel, state.panelPos, 'meshmap-vtrace-floating-placed');
            // First open on small screens: keep default CSS placement if undragged.
            if (!state.panelPos && isCompactUi()) {
              applyFloatingPos(panel, null, 'meshmap-vtrace-floating-placed');
            }
          } else {
            L.DomUtil.removeClass(root, 'meshmap-vtrace-expanded');
            L.DomUtil.removeClass(panel, 'meshmap-vtrace-panel-open');
          }
          if (!opts.skipSave) saveSession();
        }

        L.DomEvent.disableClickPropagation(root);
        L.DomEvent.disableClickPropagation(panel);
        L.DomEvent.disableScrollPropagation(panel);
        L.DomEvent.disableClickPropagation(consoleEl);
        L.DomEvent.disableScrollPropagation(consoleEl);
        L.DomEvent.on(btn, 'click', function (e) {
          L.DomEvent.preventDefault(e);
          var open = !L.DomUtil.hasClass(panel, 'meshmap-vtrace-panel-open');
          togglePanel(open);
          if (open) {
            ensureLayerOn();
          }
        });
        if (panelCloseBtn) {
          panelCloseBtn.addEventListener('click', function () {
            togglePanel(false);
          });
        }

        enableFloatingDrag(panel, panelHeader, {
          placedClass: 'meshmap-vtrace-floating-placed',
          onMoveEnd: function (pos) {
            state.panelPos = pos;
            saveSession();
          }
        });
        enableFloatingDrag(consoleEl, consoleBar, {
          placedClass: 'meshmap-vtrace-floating-placed',
          onMoveEnd: function (pos) {
            state.consolePos = pos;
            saveSession();
          }
        });
        applyFloatingPos(panel, state.panelPos, 'meshmap-vtrace-floating-placed');
        applyFloatingPos(consoleEl, state.consolePos, 'meshmap-vtrace-floating-placed');

        for (var ti = 0; ti < tabBtns.length; ti++) {
          tabBtns[ti].addEventListener('click', function (ev) {
            var tab = ev.currentTarget.getAttribute('data-tab');
            setModeTab(tab);
          });
        }

        optionsToggle.addEventListener('click', function () {
          setOptionsMinimized(!state.optionsMinimized);
        });

        hideLinksCb.checked = !!state.hideLinks;
        hideLinksCb.addEventListener('change', function () {
          state.hideLinks = !!hideLinksCb.checked;
          applyHideLinks();
          saveSession();
        });

        offsetPathsCb.checked = !!state.offsetPaths;
        offsetPathsCb.addEventListener('change', function () {
          state.offsetPaths = !!offsetPathsCb.checked;
          if (state.doc) drawDoc();
          saveSession();
        });

        autoCenterCb.checked = !!state.autoCenter;
        autoCenterCb.addEventListener('change', function () {
          state.autoCenter = !!autoCenterCb.checked;
          if (state.autoCenter && state.doc) fitMapToTrace();
          saveSession();
        });

        showHopCb.checked = !!state.showHop;
        showHopCb.addEventListener('change', function () {
          state.showHop = !!showHopCb.checked;
          if (state.doc) drawDoc();
          saveSession();
        });

        showDelayCb.checked = !!state.showDelay;
        showDelayCb.addEventListener('change', function () {
          state.showDelay = !!showDelayCb.checked;
          if (state.doc) drawDoc();
          saveSession();
        });

        consoleToggle.addEventListener('click', function () {
          state.consoleMinimized = !state.consoleMinimized;
          updateConsole();
          saveSession();
        });

        function persistFormFields() {
          saveSession();
        }
        toolSel.addEventListener('change', function () {
          syncRunsVisibility();
          persistFormFields();
        });
        sourceIn.addEventListener('change', persistFormFields);
        sourceIn.addEventListener('blur', persistFormFields);
        destIn.addEventListener('change', persistFormFields);
        destIn.addEventListener('blur', persistFormFields);
        nIn.addEventListener('change', persistFormFields);
        paste.addEventListener('blur', persistFormFields);

        function reportTextForCopy() {
          return state.rawText ||
            formatDocAsText(state.doc) ||
            (consoleBody && consoleBody.textContent) ||
            '';
        }

        function setCopyLabel(label) {
          if (consoleCopy) consoleCopy.textContent = label;
        }

        consoleCopy.addEventListener('click', function () {
          var text = reportTextForCopy();
          if (!text || text === '(no report loaded)') {
            setStatus('Nothing to copy');
            return;
          }
          function ok() {
            setCopyLabel('Copied');
            setTimeout(function () { setCopyLabel('Copy'); }, 1500);
          }
          function fail() {
            setStatus('Copy failed');
            setCopyLabel('Copy');
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok).catch(function () {
              // Fallback for non-secure contexts
              try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                var copied = document.execCommand('copy');
                document.body.removeChild(ta);
                if (copied) ok();
                else fail();
              } catch (err) {
                fail();
              }
            });
          } else {
            try {
              var ta2 = document.createElement('textarea');
              ta2.value = text;
              ta2.setAttribute('readonly', '');
              ta2.style.position = 'fixed';
              ta2.style.left = '-9999px';
              document.body.appendChild(ta2);
              ta2.select();
              var copied2 = document.execCommand('copy');
              document.body.removeChild(ta2);
              if (copied2) ok();
              else fail();
            } catch (err2) {
              fail();
            }
          }
        });

        parseBtn.addEventListener('click', function () {
          try {
            var raw = paste.value;
            var doc = parsePaste(raw);
            var keepRaw = raw.trim().charAt(0) !== '{';
            applyDoc(doc, keepRaw ? raw : null);
          } catch (err) {
            setStatus(String(err.message || err));
          }
        });
        function clearTraceUi() {
          state.doc = null;
          state.rawText = '';
          state.selected = 'all';
          clearDraw();
          paste.value = '';
          setStatus('Cleared', { skipSave: true });
          renderPathControls();
          updateConsole();
          applyHideLinks();
          saveSession();
        }
        clearBtn.addEventListener('click', clearTraceUi);
        if (clearLiveBtn) clearLiveBtn.addEventListener('click', clearTraceUi);

        async function doRun(direct) {
          var tool = toolSel.value;
          var source = sourceIn.value.trim();
          var destination = destIn.value.trim();
          var n = parseInt(nIn.value, 10) || 5;
          if (!source || !destination) {
            setStatus('Source and destination are required');
            return;
          }
          // Drop the previous overlay / paste immediately so an old path is not
          // mistaken for the new run finishing.
          state.doc = null;
          state.rawText = '';
          state.selected = 'all';
          paste.value = '';
          clearDraw();
          renderPathControls();
          updateConsole();
          applyHideLinks();

          setBusy(true);
          var progress = startProgress({ tool: tool, n: n, direct: direct });
          saveSession();
          try {
            var doc = direct
              ? await runDirect(tool, source, destination, n, progress)
              : await runViaMeshinfo(tool, source, destination, n);
            stopProgress();
            applyDoc(doc);
          } catch (err) {
            stopProgress();
            setStatus(String(err.message || err));
          } finally {
            setBusy(false);
          }
        }
        directBtn.addEventListener('click', function () { doRun(true); });

        updateConsole();
        return root;
      }
    });
    return new Ctrl();
  }

  function restoreSession() {
    var saved = readSavedSession();
    if (!saved || !control || !control._form) return;

    restoringSession = true;
    try {
      var form = control._form;
      if (saved.tool && form.toolSel) {
        form.toolSel.value = saved.tool;
      }
      if (form.nWrap) {
        form.nWrap.hidden = form.toolSel.value !== 'stableroute';
      }
      if (typeof saved.source === 'string' && form.sourceIn) {
        form.sourceIn.value = saved.source;
      }
      if (typeof saved.destination === 'string' && form.destIn) {
        form.destIn.value = saved.destination;
      }
      if (saved.n != null && form.nIn) {
        form.nIn.value = String(saved.n);
      }
      if (typeof saved.paste === 'string' && form.paste) {
        form.paste.value = saved.paste;
      }
      if (typeof saved.hideLinks === 'boolean') {
        state.hideLinks = saved.hideLinks;
        if (form.hideLinksCb) form.hideLinksCb.checked = state.hideLinks;
      }
      if (typeof saved.offsetPaths === 'boolean') {
        state.offsetPaths = saved.offsetPaths;
        if (form.offsetPathsCb) form.offsetPathsCb.checked = state.offsetPaths;
      }
      if (typeof saved.autoCenter === 'boolean') {
        state.autoCenter = saved.autoCenter;
        if (form.autoCenterCb) form.autoCenterCb.checked = state.autoCenter;
      }
      if (typeof saved.showHop === 'boolean') {
        state.showHop = saved.showHop;
        if (form.showHopCb) form.showHopCb.checked = state.showHop;
      }
      if (typeof saved.showDelay === 'boolean') {
        state.showDelay = saved.showDelay;
        if (form.showDelayCb) form.showDelayCb.checked = state.showDelay;
      }
      if (typeof saved.consoleMinimized === 'boolean') {
        state.consoleMinimized = saved.consoleMinimized;
      }
      if (saved.modeTab === 'live' || saved.modeTab === 'paste') {
        state.modeTab = saved.modeTab;
        if (typeof control._setModeTab === 'function') {
          control._setModeTab(state.modeTab, { skipSave: true });
        }
      }
      if (typeof saved.optionsMinimized === 'boolean') {
        state.optionsMinimized = saved.optionsMinimized;
        if (typeof control._setOptionsMinimized === 'function') {
          control._setOptionsMinimized(state.optionsMinimized, { skipSave: true });
        }
      }
      state.panelPos = normalizePos(saved.panelPos);
      state.consolePos = normalizePos(saved.consolePos);
      if (control._panel) {
        applyFloatingPos(control._panel, state.panelPos, 'meshmap-vtrace-floating-placed');
      }
      if (control._console) {
        applyFloatingPos(control._console, state.consolePos, 'meshmap-vtrace-floating-placed');
      }
      if (saved.selected != null) {
        state.selected = saved.selected;
      }
      if (typeof saved.status === 'string') {
        setStatus(saved.status, { skipSave: true });
      }

      var hasDoc = saved.doc && Array.isArray(saved.doc.paths) && saved.doc.paths.length;
      if (hasDoc) {
        applyDoc(saved.doc, saved.rawText || null, {
          keepSelected: true,
          keepConsole: true,
          skipSave: true
        });
      } else {
        state.doc = null;
        state.rawText = saved.rawText || '';
        renderPathControls();
        updateConsole();
        applyHideLinks();
      }

      if (saved.panelOpen && typeof control._togglePanel === 'function') {
        control._togglePanel(true, { skipSave: true });
        ensureLayerOn();
      }
    } finally {
      restoringSession = false;
    }
  }

  function onZoomOrMoveEnd() {
    // Pixel-space parallel offsets must be recomputed after zoom.
    if (state.offsetPaths && state.doc && state.doc.paths && state.doc.paths.length > 1 &&
        state.selected === 'all' && map && map.hasLayer(traceLayer)) {
      drawDoc();
    }
  }

  function onOverlayAdd(e) {
    if (syncingLayer) return;
    if (e.name === LAYER_NAME || e.layer === traceLayer) {
      if (state.doc) drawDoc();
      state.panelOpen = true;
      if (control && control._panel) {
        L.DomUtil.addClass(control._container, 'meshmap-vtrace-expanded');
        L.DomUtil.addClass(control._panel, 'meshmap-vtrace-panel-open');
      }
      saveSession();
    }
  }

  function onOverlayRemove(e) {
    if (syncingLayer) return;
    if (e.name === LAYER_NAME || e.layer === traceLayer) {
      clearDraw();
      // Layer is off: restore normal mesh-link clicks even if a doc remains.
      restoreMapLinkClicks();
      state.panelOpen = false;
      if (control && control._panel) {
        L.DomUtil.removeClass(control._container, 'meshmap-vtrace-expanded');
        L.DomUtil.removeClass(control._panel, 'meshmap-vtrace-panel-open');
      }
      saveSession();
    }
  }

  function onSpiderfyGeometryChange() {
    if (state.doc && state.doc.paths && state.doc.paths.length) {
      drawDoc();
    }
  }

  function bindSpiderfyRedraw() {
    if (typeof oms === 'undefined' || !oms || typeof oms.addListener !== 'function') return;
    if (oms._meshmapVtraceSpiderfyBound) return;
    oms._meshmapVtraceSpiderfyBound = true;
    oms.addListener('activate', onSpiderfyGeometryChange);
    oms.addListener('deactivate', onSpiderfyGeometryChange);
  }

  function init(mapInstance, allDevices, info) {
    map = mapInstance;
    mapInfo = info || {};
    indexDevices(allDevices);
    if (control) {
      try {
        if (control._console && control._console.parentNode) {
          control._console.parentNode.removeChild(control._console);
        }
        if (control._panel && control._panel.parentNode &&
            control._panel.parentNode !== control._container) {
          control._panel.parentNode.removeChild(control._panel);
        }
        map.removeControl(control);
      } catch (err) { /* ignore */ }
    }
    control = buildControl();
    control.addTo(map);
    map.off('overlayadd', onOverlayAdd);
    map.off('overlayremove', onOverlayRemove);
    map.off('zoomend', onZoomOrMoveEnd);
    map.off('resize', reclampFloatingPanels);
    map.on('overlayadd', onOverlayAdd);
    map.on('overlayremove', onOverlayRemove);
    map.on('zoomend', onZoomOrMoveEnd);
    map.on('resize', reclampFloatingPanels);
    window.addEventListener('resize', reclampFloatingPanels);
    window.addEventListener('orientationchange', function () {
      setTimeout(reclampFloatingPanels, 220);
    });
    bindSpiderfyRedraw();
    restoreSession();
    if (!readSavedSession() && mapInfo && mapInfo.localnode && control._form && control._form.sourceIn) {
      if (!control._form.sourceIn.value) {
        control._form.sourceIn.value = mapInfo.localnode;
      }
    }
    renderPathControls();
    updateConsole();
  }

  window.MeshmapVisualTrace = {
    layer: traceLayer,
    LAYER_NAME: LAYER_NAME,
    init: init,
    parsePaste: parsePaste,
    redraw: function () {
      if (state.doc) drawDoc();
    }
  };
})(window);
