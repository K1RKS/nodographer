/**
 * Mobile / tablet helpers for Nodographer map chrome.
 * invalidateSize on rotate, compact layers, default-collapsed legend, more-tools.
 */
(function (window) {
  function isCompactUi() {
    try {
      return window.matchMedia('(max-width: 700px), (pointer: coarse)').matches;
    } catch (e) {
      return window.innerWidth <= 700;
    }
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var ctx = this;
      var args = arguments;
      if (t) clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(ctx, args);
      }, ms);
    };
  }

  function bindInvalidateSize(map) {
    if (!map) return;
    var relayout = debounce(function () {
      try {
        map.invalidateSize({ animate: false });
      } catch (e) {}
    }, 120);

    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', function () {
      setTimeout(relayout, 220);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', relayout);
    }
    // Initial pass after layout settles
    setTimeout(relayout, 50);
  }

  function collapseLayerControl(layerControls) {
    if (!layerControls) return;
    try {
      if (typeof layerControls._collapse === 'function') {
        layerControls._collapse();
      } else if (layerControls._container) {
        L.DomUtil.removeClass(layerControls._container, 'leaflet-control-layers-expanded');
      }
    } catch (e) {}
  }

  function bindLayerAutoCollapse(map, layerControls) {
    if (!map || !layerControls) return;

    function maybeCollapse() {
      if (!isCompactUi()) return;
      collapseLayerControl(layerControls);
    }

    map.on('click', maybeCollapse);
    map.on('baselayerchange', maybeCollapse);
    map.on('overlayadd', maybeCollapse);
    map.on('overlayremove', maybeCollapse);
  }

  function collapseLegendForMobile() {
    if (!isCompactUi()) return;
    var lgd = document.getElementsByClassName('legend');
    var lgdHidden = document.getElementsByClassName('legendHidden');
    if (!lgd.length || !lgdHidden.length) return;
    lgd[0].style.display = 'none';
    lgdHidden[0].style.display = 'block';
  }

  function popupOptions() {
    var pad = 48;
    var maxW = Math.min(350, Math.max(220, window.innerWidth - 32));
    return {
      maxWidth: maxW,
      autoPan: true,
      autoPanPadding: [pad, pad],
      keepInView: true
    };
  }

  /**
   * Compact "More" control: ruler + node list on narrow screens.
   * Desktop keeps separate ruler / list controls (CSS hides this bar).
   */
  function createMoreToolsControl(options) {
    options = options || {};
    return L.control({ position: options.position || 'verticalcenterleft' });
  }

  // Full control class
  if (window.L) {
    L.Control.MeshmapMoreTools = L.Control.extend({
      options: { position: 'verticalcenterleft' },
      onAdd: function () {
        var container = L.DomUtil.create(
          'div',
          'leaflet-bar leaflet-control meshmap-more-tools'
        );
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);

        var toggle = L.DomUtil.create('a', 'meshmap-more-toggle', container);
        toggle.href = '#';
        toggle.title = 'More tools';
        toggle.setAttribute('role', 'button');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.innerHTML = '&#8943;';

        var panel = L.DomUtil.create('div', 'meshmap-more-panel', container);
        panel.hidden = true;

        var rulerProxy = L.DomUtil.create('a', 'meshmap-more-item', panel);
        rulerProxy.href = '#';
        rulerProxy.title = 'Ruler';
        rulerProxy.textContent = 'Ruler';

        var listLink = L.DomUtil.create('a', 'meshmap-more-item', panel);
        listLink.href = 'node_report/index.html';
        listLink.title = 'View as list (node report)';
        listLink.textContent = 'List';

        L.DomEvent.on(toggle, 'click', function (e) {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          var open = panel.hidden;
          panel.hidden = !open;
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (open) L.DomUtil.addClass(container, 'meshmap-more-open');
          else L.DomUtil.removeClass(container, 'meshmap-more-open');
        });

        L.DomEvent.on(rulerProxy, 'click', function (e) {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          var ruler = document.getElementById('ruler');
          if (ruler) ruler.click();
          panel.hidden = true;
          toggle.setAttribute('aria-expanded', 'false');
          L.DomUtil.removeClass(container, 'meshmap-more-open');
        });

        return container;
      }
    });

    L.control.meshmapMoreTools = function (opts) {
      return new L.Control.MeshmapMoreTools(opts);
    };
  }

  function bindPopupScroll(map) {
    if (!map) return;
    map.on('popupopen', function (e) {
      var root = e.popup && e.popup.getElement ? e.popup.getElement() : null;
      if (!root || !window.L) return;
      var panes = root.querySelectorAll(
        '.popupTabContent, .popupTabContent-fw, .leaflet-popup-content'
      );
      for (var i = 0; i < panes.length; i++) {
        L.DomEvent.disableClickPropagation(panes[i]);
        L.DomEvent.disableScrollPropagation(panes[i]);
      }
    });
  }

  function enhanceMap(map, layerControls) {
    bindInvalidateSize(map);
    bindLayerAutoCollapse(map, layerControls);
    bindPopupScroll(map);
    collapseLegendForMobile();
  }

  window.MeshmapMobile = {
    isCompactUi: isCompactUi,
    bindInvalidateSize: bindInvalidateSize,
    bindLayerAutoCollapse: bindLayerAutoCollapse,
    bindPopupScroll: bindPopupScroll,
    collapseLegendForMobile: collapseLegendForMobile,
    collapseLayerControl: collapseLayerControl,
    popupOptions: popupOptions,
    enhanceMap: enhanceMap
  };
})(window);
