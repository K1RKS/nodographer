/**
 * Meshmap (== Nodographer frontend) search control.
 * Two modes:
 *  - Address: geocodes a typed address, centers the map on it, and drops a
 *    marker. Markers accumulate, persist for the tab session (survive the
 *    page's auto-refresh), and have a right-click / long-press menu.
 *  - Node: autocompletes node names from the map's node markers and jumps
 *    to the chosen node.
 */
(function (window) {
  var DEFAULT_GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';
  var RESULT_LIMIT = 5;
  var RESULT_ZOOM = 17;
  var NODE_RESULT_LIMIT = 12;
  var NODE_ZOOM = 16;
  var FETCH_TIMEOUT_MS = 10000;
  var SESSION_KEY = 'addressMarkers';
  var MODE_SESSION_KEY = 'searchMode';
  // Screens where the on-screen keyboard would cover a panel beside the left rail
  var DOCK_QUERY = '(pointer: coarse), (max-width: 700px)';

  var MODES = {
    address: { label: 'Address', placeholder: 'Search address...', aria: 'Address' },
    node: { label: 'Node', placeholder: 'Node name...', aria: 'Node name' },
  };

  var SEARCH_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path fill="currentColor" d="M10 2a8 8 0 0 1 6.32 12.9l5.39 5.4-1.41 1.4-5.4-5.39A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z"/>' +
    '</svg>';

  var map = null;
  var getNodeMarkers = function () { return []; };
  var geocoderUrl = DEFAULT_GEOCODER_URL;
  var markerLayer = null;
  var entries = [];
  var toastEl = null;
  var toastTimer = null;
  var addressIcon = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtCoord(n) {
    return Number(n).toFixed(6);
  }

  // ----- Session persistence -----

  function saveSession() {
    if (!window.MeshmapSession) return;
    MeshmapSession.write({
      addressMarkers: entries.map(function (e) {
        return { lat: e.lat, lon: e.lon, label: e.label };
      }),
    });
  }

  function restoreSession() {
    if (!window.MeshmapSession) return;
    var s = MeshmapSession.read();
    var list = s && Array.isArray(s[SESSION_KEY]) ? s[SESSION_KEY] : [];
    list.forEach(function (item) {
      var lat = parseFloat(item && item.lat);
      var lon = parseFloat(item && item.lon);
      if (isNaN(lat) || isNaN(lon)) return;
      addMarker(lat, lon, item.label || '', { save: false });
    });
  }

  // ----- Markers -----

  function addMarker(lat, lon, label, opts) {
    opts = opts || {};
    var marker = L.marker([lat, lon], {
      icon: addressIcon,
      title: label,
      alt: label || 'Address marker',
      riseOnHover: true,
    });
    var entry = { lat: lat, lon: lon, label: label, marker: marker };

    marker.bindPopup(
      '<div class="meshmap-addr-popup">' +
        '<div class="meshmap-addr-popup-label">' + escapeHtml(label || 'Address') + '</div>' +
        '<div class="meshmap-addr-popup-coords">' + fmtCoord(lat) + ', ' + fmtCoord(lon) + '</div>' +
        '<div class="meshmap-addr-popup-hint">Right-click (long-press on touch) for options</div>' +
      '</div>'
    );

    MeshmapMarkerMenu.takeOverPopupClick(marker, function () {
      return L.latLng(entry.lat, entry.lon);
    });

    marker.on('contextmenu', function (e) {
      if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
      marker.closePopup();
      openMenu(entry, e.containerPoint || map.latLngToContainerPoint(marker.getLatLng()));
    });

    marker.addTo(markerLayer);
    entries.push(entry);
    if (opts.save !== false) saveSession();
    return entry;
  }

  function removeEntry(entry) {
    markerLayer.removeLayer(entry.marker);
    entries = entries.filter(function (e) {
      return e !== entry;
    });
    saveSession();
  }

  // ----- Context menu -----

  function openMenu(entry, point) {
    var latlng = L.latLng(entry.lat, entry.lon);
    var coordText = fmtCoord(entry.lat) + ', ' + fmtCoord(entry.lon);
    var ruler = MeshmapMarkerMenu.rulerItem(latlng);
    var items = [
      ruler,
      ruler ? { separator: true } : null,
      { text: 'Center map here', action: function () { map.panTo(latlng); } },
      { text: 'Copy coordinates', action: function () { copyText(coordText); } },
      { text: 'Copy address', disabled: !entry.label, action: function () { copyText(entry.label); } },
      {
        text: 'Open in OpenStreetMap',
        action: function () {
          window.open(
            'https://www.openstreetmap.org/?mlat=' + entry.lat + '&mlon=' + entry.lon +
              '#map=' + RESULT_ZOOM + '/' + entry.lat + '/' + entry.lon,
            '_blank',
            'noopener'
          );
        },
      },
      {
        text: 'Open in Google Maps',
        action: function () {
          window.open('https://www.google.com/maps?q=' + entry.lat + ',' + entry.lon, '_blank', 'noopener');
        },
      },
      { separator: true },
      { text: 'Remove marker', danger: true, action: function () { removeEntry(entry); } },
    ];

    MeshmapMarkerMenu.open(point, entry.label || coordText, items);
  }

  // ----- Clipboard + toast -----

  function showToast(text) {
    if (!toastEl) {
      toastEl = L.DomUtil.create('div', 'meshmap-addr-toast', map.getContainer());
    }
    toastEl.textContent = text;
    toastEl.classList.add('meshmap-addr-toast-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('meshmap-addr-toast-visible');
    }, 1600);
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    // execCommand must run synchronously inside the click gesture, and the
    // Clipboard API is unavailable on plain-HTTP mesh pages, so try it first
    if (legacyCopy(text)) {
      showToast('Copied');
      return;
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () { showToast('Copied'); },
        function () { showToast('Copy failed: ' + text); }
      );
      return;
    }
    showToast('Copy failed: ' + text);
  }

  // ----- Geocoding -----

  function buildQueryUrl(query) {
    var params = [
      'format=jsonv2',
      'limit=' + RESULT_LIMIT,
      'q=' + encodeURIComponent(query),
    ];
    // Prefer results near the current view without excluding others
    try {
      var b = map.getBounds();
      params.push(
        'viewbox=' +
          [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()]
            .map(function (n) { return n.toFixed(5); })
            .join(',')
      );
      params.push('bounded=0');
    } catch (e) {}
    return geocoderUrl + (geocoderUrl.indexOf('?') === -1 ? '?' : '&') + params.join('&');
  }

  function geocode(query) {
    var controller = window.AbortController ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS) : null;
    return fetch(buildQueryUrl(query), {
      headers: { Accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (data) {
        if (!Array.isArray(data)) return [];
        return data
          .map(function (r) {
            return {
              lat: parseFloat(r.lat),
              lon: parseFloat(r.lon),
              label: r.display_name || query,
            };
          })
          .filter(function (r) {
            return !isNaN(r.lat) && !isNaN(r.lon);
          });
      })
      .finally(function () {
        if (timer) clearTimeout(timer);
      });
  }

  // ----- Node lookup -----

  function findNodes(query) {
    var q = (query || '').trim().toLowerCase();
    if (!q) return [];
    var hits = [];
    var byName = {};
    (getNodeMarkers() || []).forEach(function (marker) {
      var name = marker && marker.options && marker.options.title;
      if (!name) return;
      var lower = String(name).toLowerCase();
      var pos = lower.indexOf(q);
      if (pos === -1) return;
      // Map data can list the same node more than once; keep one, preferring a visible marker
      var seen = byName[lower];
      if (seen) {
        if (!map.hasLayer(seen.marker) && map.hasLayer(marker)) seen.marker = marker;
        return;
      }
      // Prefix matches first, then matches at a word boundary, then anywhere
      var rank = pos === 0 ? 0 : /[-_.\s]/.test(lower.charAt(pos - 1)) ? 1 : 2;
      byName[lower] = { name: String(name), marker: marker, rank: rank };
      hits.push(byName[lower]);
    });
    hits.sort(function (a, b) {
      return a.rank - b.rank || a.name.localeCompare(b.name);
    });
    return hits.slice(0, NODE_RESULT_LIMIT);
  }

  function nodeIconUrl(marker) {
    var icon = marker.options && marker.options.icon;
    return (icon && icon.options && icon.options.iconUrl) || '';
  }

  function savedMode() {
    if (!window.MeshmapSession) return 'address';
    var s = MeshmapSession.read();
    var mode = s && s[MODE_SESSION_KEY];
    return MODES[mode] ? mode : 'address';
  }

  // ----- Control -----

  var AddressSearchControl = L.Control.extend({
    options: { position: 'verticalcenterleft' },

    onAdd: function () {
      var self = this;
      var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control meshmap-addr-search');
      container.title = 'Find an address or node';

      var button = L.DomUtil.create('a', 'meshmap-addr-search-button', container);
      button.href = '#';
      button.setAttribute('role', 'button');
      button.setAttribute('aria-label', 'Find an address or node');
      button.innerHTML = SEARCH_SVG;

      var panel = L.DomUtil.create('div', 'meshmap-addr-search-panel', container);
      var modeBar = L.DomUtil.create('div', 'meshmap-addr-search-modes', panel);
      modeBar.setAttribute('role', 'tablist');
      this._modeButtons = {};
      Object.keys(MODES).forEach(function (mode) {
        var tab = L.DomUtil.create('button', 'meshmap-addr-search-mode', modeBar);
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.textContent = 'Find ' + MODES[mode].label;
        L.DomEvent.on(tab, 'click', function (ev) {
          L.DomEvent.stop(ev);
          self.setMode(mode);
          self._input.focus();
        });
        self._modeButtons[mode] = tab;
      });

      var form = L.DomUtil.create('form', 'meshmap-addr-search-form', panel);
      var input = L.DomUtil.create('input', 'meshmap-addr-search-input', form);
      input.type = 'search';
      input.autocomplete = 'off';
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('spellcheck', 'false');
      var message = L.DomUtil.create('div', 'meshmap-addr-search-message', panel);
      var results = L.DomUtil.create('ul', 'meshmap-addr-search-results', panel);

      this._container = container;
      this._panel = panel;
      this._input = input;
      this._message = message;
      this._results = results;
      this._items = [];
      this._active = -1;
      this._busy = false;

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      // The panel is moved out of the container when docked, so it needs its own guards
      L.DomEvent.disableClickPropagation(panel);
      L.DomEvent.disableScrollPropagation(panel);

      if (window.visualViewport) {
        var refit = function () {
          if (self.isExpanded()) self._fitResults();
        };
        window.visualViewport.addEventListener('resize', refit);
        window.visualViewport.addEventListener('scroll', refit);
      }

      L.DomEvent.on(button, 'click', function (ev) {
        L.DomEvent.preventDefault(ev);
        if (self.isExpanded()) self.collapse();
        else self.expand();
      });

      L.DomEvent.on(form, 'submit', function (ev) {
        L.DomEvent.preventDefault(ev);
        self._submit();
      });

      L.DomEvent.on(input, 'input', function () {
        if (self._mode === 'node') self._suggestNodes(input.value);
      });

      L.DomEvent.on(input, 'keydown', function (ev) {
        if (ev.key === 'Escape') {
          L.DomEvent.stop(ev);
          self.collapse();
        } else if (ev.key === 'Enter') {
          L.DomEvent.stop(ev);
          self._submit();
        } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          if (!self._items.length) return;
          L.DomEvent.stop(ev);
          self._moveActive(ev.key === 'ArrowDown' ? 1 : -1);
        }
      });

      this.setMode(savedMode());
      return container;
    },

    setMode: function (mode) {
      if (!MODES[mode]) return;
      var changed = this._mode !== mode;
      this._mode = mode;
      Object.keys(this._modeButtons).forEach(function (m) {
        var on = m === mode;
        L.DomUtil[on ? 'addClass' : 'removeClass'](this._modeButtons[m], 'meshmap-addr-search-mode-active');
        this._modeButtons[m].setAttribute('aria-selected', on ? 'true' : 'false');
      }, this);
      this._input.placeholder = MODES[mode].placeholder;
      this._input.setAttribute('aria-label', MODES[mode].aria);
      if (!changed) return;
      if (window.MeshmapSession) {
        var patch = {};
        patch[MODE_SESSION_KEY] = mode;
        MeshmapSession.write(patch);
      }
      this._clearResults();
      this._setMessage('');
      if (mode === 'node') this._suggestNodes(this._input.value);
    },

    isExpanded: function () {
      return L.DomUtil.hasClass(this._container, 'meshmap-addr-search-expanded');
    },

    expand: function () {
      this._dock(!!(window.matchMedia && window.matchMedia(DOCK_QUERY).matches));
      L.DomUtil.addClass(this._container, 'meshmap-addr-search-expanded');
      L.DomUtil.addClass(this._panel, 'meshmap-addr-search-panel-open');
      this._input.focus();
      this._input.select();
      this._fitResults();
    },

    collapse: function () {
      L.DomUtil.removeClass(this._container, 'meshmap-addr-search-expanded');
      L.DomUtil.removeClass(this._panel, 'meshmap-addr-search-panel-open');
      this._clearResults();
      this._setMessage('');
      this._input.blur();
      this._dock(false);
    },

    // Docked: pinned to the top of the map so the keyboard can't cover it. It has to
    // leave the left rail, whose transform would otherwise anchor it mid-screen.
    _dock: function (on) {
      var home = on ? map.getContainer() : this._container;
      if (this._panel.parentNode !== home) home.appendChild(this._panel);
      L.DomUtil[on ? 'addClass' : 'removeClass'](this._panel, 'meshmap-addr-search-panel-docked');
    },

    // Keep the result list inside the part of the screen the keyboard leaves visible
    _fitResults: function () {
      var list = this._results;
      if (!L.DomUtil.hasClass(this._panel, 'meshmap-addr-search-panel-docked')) {
        list.style.maxHeight = '';
        return;
      }
      var vv = window.visualViewport;
      var bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      var top = list.getBoundingClientRect().top;
      if (!top) return;
      list.style.maxHeight = Math.max(88, Math.floor(bottom - top - 8)) + 'px';
    },

    _setMessage: function (text, isError) {
      this._message.textContent = text || '';
      L.DomUtil[isError ? 'addClass' : 'removeClass'](this._message, 'meshmap-addr-search-error');
    },

    _clearResults: function () {
      this._results.innerHTML = '';
      this._items = [];
      this._active = -1;
    },

    _submit: function () {
      if (this._active >= 0 && this._items[this._active]) {
        this._items[this._active].pick();
        return;
      }
      if (this._mode === 'node') {
        var hits = findNodes(this._input.value);
        if (hits.length) this._pickNode(hits[0]);
        else this._suggestNodes(this._input.value);
        return;
      }
      this.search(this._input.value);
    },

    _moveActive: function (delta) {
      var n = this._items.length;
      var next = this._active < 0 ? (delta > 0 ? 0 : n - 1) : (this._active + delta + n) % n;
      if (this._active >= 0) {
        L.DomUtil.removeClass(this._items[this._active].el, 'meshmap-addr-search-result-active');
      }
      this._active = next;
      var el = this._items[next].el;
      L.DomUtil.addClass(el, 'meshmap-addr-search-result-active');
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    },

    _place: function (r) {
      addMarker(r.lat, r.lon, r.label);
      map.setView([r.lat, r.lon], Math.max(map.getZoom(), RESULT_ZOOM));
      this.collapse();
    },

    _pickNode: function (hit) {
      var marker = hit.marker;
      var visible = map.hasLayer(marker);
      this.collapse();
      if (visible) {
        map.once('moveend', function () { marker.openPopup(); });
      } else {
        showToast(hit.name + ' is in a hidden layer');
      }
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), NODE_ZOOM));
    },

    // items: [{ label, iconUrl?, pick }]
    _showResults: function (items) {
      var self = this;
      this._clearResults();
      items.forEach(function (item) {
        var li = L.DomUtil.create('li', 'meshmap-addr-search-result', self._results);
        if (item.iconUrl) {
          L.DomUtil.addClass(li, 'meshmap-addr-search-result-node');
          var img = L.DomUtil.create('img', 'meshmap-addr-search-result-icon', li);
          img.src = item.iconUrl;
          img.alt = '';
          li.appendChild(document.createTextNode(item.label));
        } else {
          li.textContent = item.label;
        }
        li.title = item.label;
        li.tabIndex = 0;
        L.DomEvent.on(li, 'click', function (ev) {
          L.DomEvent.stop(ev);
          item.pick();
        });
        L.DomEvent.on(li, 'keydown', function (ev) {
          if (ev.key === 'Enter') {
            L.DomEvent.stop(ev);
            item.pick();
          }
        });
        self._items.push({ el: li, pick: item.pick });
      });
      this._fitResults();
    },

    _suggestNodes: function (raw) {
      var self = this;
      var query = (raw || '').trim();
      if (!query) {
        this._clearResults();
        this._setMessage('');
        return;
      }
      var hits = findNodes(query);
      if (!hits.length) {
        this._clearResults();
        this._setMessage('No node matches "' + query + '"', true);
        return;
      }
      this._setMessage('');
      this._showResults(hits.map(function (hit) {
        return {
          label: hit.name,
          iconUrl: nodeIconUrl(hit.marker),
          pick: function () { self._pickNode(hit); },
        };
      }));
    },

    search: function (raw) {
      var self = this;
      var query = (raw || '').trim();
      if (!query || this._busy) return;
      this._busy = true;
      this._clearResults();
      this._setMessage('Searching...');
      geocode(query)
        .then(function (list) {
          if (!list.length) {
            self._setMessage('No match for "' + query + '"', true);
            return;
          }
          if (list.length === 1) {
            self._place(list[0]);
            return;
          }
          self._setMessage('Pick a result:');
          self._showResults(list.map(function (r) {
            return { label: r.label, pick: function () { self._place(r); } };
          }));
        })
        .catch(function (err) {
          console.warn('address search failed', err);
          self._setMessage('Address lookup unavailable (no internet access?)', true);
        })
        .finally(function () {
          self._busy = false;
        });
    },
  });

  // opts.getNodeMarkers: () => L.Marker[] whose options.title is the node name
  function init(leafletMap, mapInfo, opts) {
    if (!leafletMap || !window.L || !window.MeshmapMarkerMenu) return;
    map = leafletMap;
    if (opts && typeof opts.getNodeMarkers === 'function') {
      getNodeMarkers = opts.getNodeMarkers;
    }
    MeshmapMarkerMenu.init(map);
    if (mapInfo && typeof mapInfo.geocoderUrl === 'string' && mapInfo.geocoderUrl) {
      geocoderUrl = mapInfo.geocoderUrl;
    }

    addressIcon = L.icon({
      iconUrl: 'images/mapMarkers/Red_Marker.png',
      iconSize: [36, 36],
      iconAnchor: [18, 35],
      popupAnchor: [0, -32],
      className: 'meshmap-addr-marker',
    });

    markerLayer = L.layerGroup().addTo(map);
    var control = new AddressSearchControl().addTo(map);

    map.on('click', function () {
      if (control.isExpanded()) control.collapse();
    });

    restoreSession();
  }

  window.MeshmapAddressSearch = {
    init: init,
    addMarker: function (lat, lon, label) {
      return map ? addMarker(lat, lon, label || '') : null;
    },
  };
})(window);
