/**
 * Mobile / tablet helpers for Nodographer map chrome.
 * invalidateSize on rotate, compact layers, default-collapsed legend, control rail slide.
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

  function isShortViewport() {
    try {
      return window.matchMedia('(max-height: 560px)').matches;
    } catch (e) {
      return window.innerHeight <= 560;
    }
  }

  /**
   * On short (usually landscape phone) screens, let the left control rail
   * be dragged up/down so cut-off icons can be reached.
   */
  function bindControlRailSlide(map) {
    if (!map || !map._controlCorners || !window.L) return;
    var rail = map._controlCorners.verticalcenterleft;
    if (!rail) return;

    var offset = 0;
    var startY = 0;
    var startOffset = 0;
    var dragging = false;
    var moved = false;
    var dragDisabledMap = false;

    function viewBox() {
      var vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      var vvTop = window.visualViewport ? window.visualViewport.offsetTop : 0;
      return { top: vvTop + 6, bottom: vvTop + vh - 6 };
    }

    function childExtent() {
      var kids = rail.children;
      var top = Infinity;
      var bottom = -Infinity;
      for (var i = 0; i < kids.length; i++) {
        var r = kids[i].getBoundingClientRect();
        if (!r.height && !r.width) continue;
        if (r.top < top) top = r.top;
        if (r.bottom > bottom) bottom = r.bottom;
      }
      if (!isFinite(top)) {
        var rr = rail.getBoundingClientRect();
        return { top: rr.top, bottom: rr.bottom };
      }
      return { top: top, bottom: bottom };
    }

    function slideLimits() {
      var box = viewBox();
      var ext = childExtent();
      var natTop = ext.top - offset;
      var natBottom = ext.bottom - offset;
      var h = natBottom - natTop;
      var room = box.bottom - box.top;
      if (h <= room + 2) {
        return { min: 0, max: 0 };
      }
      var topAlign = box.top - natTop;
      var bottomAlign = box.bottom - natBottom;
      return {
        min: Math.min(topAlign, bottomAlign),
        max: Math.max(topAlign, bottomAlign)
      };
    }

    function applyOffset() {
      if (!isShortViewport()) {
        offset = 0;
        rail.style.top = '';
        rail.style.transform = '';
        L.DomUtil.removeClass(rail, 'meshmap-rail-overflow');
        return;
      }
      rail.style.top = 'max(6px, env(safe-area-inset-top, 0px))';
      var lim = slideLimits();
      if (offset < lim.min) offset = lim.min;
      if (offset > lim.max) offset = lim.max;
      rail.style.transform = 'translateY(' + offset + 'px)';
      if (lim.min < lim.max) L.DomUtil.addClass(rail, 'meshmap-rail-overflow');
      else L.DomUtil.removeClass(rail, 'meshmap-rail-overflow');
    }

    function eventY(e) {
      if (e.touches && e.touches.length) return e.touches[0].clientY;
      if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientY;
      return e.clientY;
    }

    function isExpandedLayers(t) {
      if (!t || !t.closest) return false;
      return !!t.closest('.leaflet-control-layers-expanded .leaflet-control-layers-list');
    }

    function onStart(e) {
      if (!isShortViewport()) return;
      applyOffset();
      var lim = slideLimits();
      if (lim.min >= lim.max) return;
      if (isExpandedLayers(e.target)) return;
      dragging = true;
      moved = false;
      startY = eventY(e);
      startOffset = offset;
      if (map.dragging && map.dragging.enabled()) {
        map.dragging.disable();
        dragDisabledMap = true;
      }
      L.DomEvent.stopPropagation(e);
    }

    function onMove(e) {
      if (!dragging) return;
      var y = eventY(e);
      var dy = y - startY;
      if (!moved && Math.abs(dy) < 8) return;
      moved = true;
      offset = startOffset + dy;
      applyOffset();
      L.DomEvent.preventDefault(e);
      L.DomEvent.stopPropagation(e);
    }

    function onEnd(e) {
      if (!dragging) return;
      dragging = false;
      if (dragDisabledMap && map.dragging) {
        map.dragging.enable();
        dragDisabledMap = false;
      }
      if (moved) {
        L.DomEvent.preventDefault(e);
        L.DomEvent.stopPropagation(e);
      }
    }

    L.DomEvent.disableClickPropagation(rail);
    L.DomEvent.on(rail, 'mousedown', onStart);
    rail.addEventListener('touchstart', onStart, { passive: false });
    L.DomEvent.on(document, 'mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    L.DomEvent.on(document, 'mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);

    window.addEventListener('resize', applyOffset);
    window.addEventListener('orientationchange', function () {
      offset = 0;
      setTimeout(applyOffset, 250);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', applyOffset);
    }
    setTimeout(applyOffset, 80);
  }

  function enhanceMap(map, layerControls) {
    bindInvalidateSize(map);
    bindLayerAutoCollapse(map, layerControls);
    bindPopupScroll(map);
    bindControlRailSlide(map);
    collapseLegendForMobile();
  }

  window.MeshmapMobile = {
    isCompactUi: isCompactUi,
    bindInvalidateSize: bindInvalidateSize,
    bindLayerAutoCollapse: bindLayerAutoCollapse,
    bindPopupScroll: bindPopupScroll,
    bindControlRailSlide: bindControlRailSlide,
    collapseLegendForMobile: collapseLegendForMobile,
    collapseLayerControl: collapseLayerControl,
    popupOptions: popupOptions,
    enhanceMap: enhanceMap
  };
})(window);
