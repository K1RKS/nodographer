/**
 * Meshmap (== Nodographer frontend) session persistence.
 * Keeps tileserver (base layer), pan/zoom, and overlay toggles for the
 * browser tab session via sessionStorage. Cleared when the tab is closed.
 */
(function (window) {
  var STORAGE_KEY = 'meshmap.session.v1';

  function readSession() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : null;
    } catch (e) {
      console.warn('meshmap session read failed', e);
      return null;
    }
  }

  function writeSession(patch) {
    try {
      var cur = readSession() || {};
      Object.keys(patch).forEach(function (k) {
        cur[k] = patch[k];
      });
      cur.updatedAt = Date.now();
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cur));
    } catch (e) {
      console.warn('meshmap session write failed', e);
    }
  }

  function hasUrlHashView() {
    var h = window.location.hash || '';
    if (h.charAt(0) === '#') h = h.substr(1);
    var args = h.split('/');
    if (args.length !== 3) return false;
    return !(
      isNaN(parseInt(args[0], 10)) ||
      isNaN(parseFloat(args[1])) ||
      isNaN(parseFloat(args[2]))
    );
  }

  function resolveBaseLayerName(tileOrder, configuredDefault) {
    var s = readSession();
    if (s && s.baseLayer && tileOrder.indexOf(s.baseLayer) !== -1) {
      return s.baseLayer;
    }
    if (configuredDefault && tileOrder.indexOf(configuredDefault) !== -1) {
      return configuredDefault;
    }
    return tileOrder.length ? tileOrder[0] : null;
  }

  function resolveInitialView(mapInfo) {
    var configuredCenter = mapInfo.mapCenterCoords;
    var configuredZoom = mapInfo.mapInitialZoom;
    var s = readSession();

    // Shareable URL hash wins when present
    if (hasUrlHashView()) {
      return { center: configuredCenter, zoom: configuredZoom, source: 'hash' };
    }
    if (
      s &&
      Array.isArray(s.center) &&
      s.center.length === 2 &&
      typeof s.zoom === 'number'
    ) {
      return { center: s.center, zoom: s.zoom, source: 'session' };
    }
    return {
      center: configuredCenter,
      zoom: configuredZoom,
      source: 'config',
    };
  }

  function bindMapSession(map, baseLayers, overlayNameByLayer) {
    if (!map) return;

    map.on('baselayerchange', function (e) {
      if (e && e.name) {
        writeSession({ baseLayer: e.name });
      }
    });

    var saveView = function () {
      var c = map.getCenter();
      writeSession({
        center: [c.lat, c.lng],
        zoom: map.getZoom(),
      });
    };
    map.on('moveend', saveView);
    map.on('zoomend', saveView);
    saveView();

    function overlayKey(e) {
      if (!e) return null;
      if (e.name) return e.name;
      if (overlayNameByLayer && e.layer && overlayNameByLayer.has(e.layer)) {
        return overlayNameByLayer.get(e.layer);
      }
      return null;
    }

    map.on('overlayadd', function (e) {
      var name = overlayKey(e);
      if (!name) return;
      var s = readSession() || {};
      var list = Array.isArray(s.overlays) ? s.overlays.slice() : [];
      if (list.indexOf(name) === -1) list.push(name);
      writeSession({ overlays: list });
    });

    map.on('overlayremove', function (e) {
      var name = overlayKey(e);
      if (!name) return;
      var s = readSession() || {};
      var list = Array.isArray(s.overlays)
        ? s.overlays.filter(function (n) {
            return n !== name;
          })
        : [];
      writeSession({ overlays: list });
    });
  }

  function restoreOverlays(map, overlayLayers) {
    var s = readSession();
    if (!s || !Array.isArray(s.overlays) || !overlayLayers) return;

    var wanted = {};
    s.overlays.forEach(function (n) {
      wanted[n] = true;
    });

    Object.keys(overlayLayers).forEach(function (name) {
      var layer = overlayLayers[name];
      if (!layer) return;
      var shouldBeOn = !!wanted[name];
      var isOn = map.hasLayer(layer);
      if (shouldBeOn && !isOn) map.addLayer(layer);
      if (!shouldBeOn && isOn) map.removeLayer(layer);
    });
  }

  window.MeshmapSession = {
    read: readSession,
    write: writeSession,
    resolveBaseLayerName: resolveBaseLayerName,
    resolveInitialView: resolveInitialView,
    hasUrlHashView: hasUrlHashView,
    bindMapSession: bindMapSession,
    restoreOverlays: restoreOverlays,
    STORAGE_KEY: STORAGE_KEY,
  };
})(window);
