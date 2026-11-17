/**
 * 
 */

function linkColorsRF_txRate(value, linkMetric) {
	// value = value / 2;
	var midValue = 30;
	if(linkMetric === "txRate") {
		midValue = 50;
	}
	if(linkMetric === "SnR") {
		midValue = 20;
	}
	var color;
	var colorParts;
	if(value > midValue) {
		colorParts = (1 - ((value - midValue) / midValue));
	}else {
		colorParts = value / midValue;
	}
	colorParts = Math.round(colorParts * 255);
	if(value < midValue) {
		colorParts = parseInt(colorParts).toString(16);
		if(colorParts.length == 1) {
			colorParts = "0" + colorParts;
		}
		color = "#FF" + colorParts + "00"; 
	}else if(value > midValue) {
		if(colorParts < 0) {
			colorParts = colorParts * -1;
		}
		colorParts = parseInt(colorParts).toString(16);
		if(colorParts.length == 1) {
			colorParts = "0" + colorParts;
		}
		color = "#" + colorParts + "FF00";
		
	}else {
		color = "#FFFF00";
	}
	return color;
}

function linkColorRF_cost(value) {
	value = parseFloat(value);
	var color = "#FF0000";
	if(value <= 1) {
		color = "#00FF00";
	}
	if(value > 1 && value <= 1.5) {
		color = "#FF7700";
	}
	if(value > 1.5 && value < 2) {
		color = "#FFFF00";
	}
	return color;
}

function linkColorRF_quality(value) {
	value = parseFloat(value);
	var color = "#FF0000";
	if(value >= 1) {
		color = "#00FF00";
	}
	if(value < 1 && value > 0.6) {
		color = "#FFFF00";
	}
	return color;
}

function meshmapNodeKey(name) {
	return String(name || '').toLowerCase().replace(/\.local\.mesh$/i, '');
}

/** Live marker lat/lng by node key (reflects spiderfy fan-out). */
function meshmapMarkerPositionsByNode() {
	var out = {};
	if (typeof oms === 'undefined' || !oms || typeof oms.getMarkers !== 'function') {
		return out;
	}
	oms.getMarkers().forEach(function (marker) {
		var title = marker && marker.options && marker.options.title;
		if (!title || typeof marker.getLatLng !== 'function') return;
		var ll = marker.getLatLng();
		if (!ll) return;
		out[meshmapNodeKey(title)] = [ll.lat, ll.lng];
	});
	return out;
}

/**
 * Re-anchor RF/DTD/TUN link polylines to current marker positions so that
 * when Spiderfy fans out co-located nodes, links follow the visible markers.
 */
function meshmapApplySpiderfyToLinks() {
	var pos = meshmapMarkerPositionsByNode();
	var layers = [
		typeof twoLinksTX !== 'undefined' ? twoLinksTX : null,
		typeof twoLinksThp !== 'undefined' ? twoLinksThp : null,
		typeof twoLinksSnR !== 'undefined' ? twoLinksSnR : null,
		typeof twoLinksCost !== 'undefined' ? twoLinksCost : null,
		typeof twoLinksQual !== 'undefined' ? twoLinksQual : null,
		typeof threeLinksTX !== 'undefined' ? threeLinksTX : null,
		typeof threeLinksThp !== 'undefined' ? threeLinksThp : null,
		typeof threeLinksSnR !== 'undefined' ? threeLinksSnR : null,
		typeof threeLinksCost !== 'undefined' ? threeLinksCost : null,
		typeof threeLinksQual !== 'undefined' ? threeLinksQual : null,
		typeof fiveLinksTX !== 'undefined' ? fiveLinksTX : null,
		typeof fiveLinksThp !== 'undefined' ? fiveLinksThp : null,
		typeof fiveLinksSnR !== 'undefined' ? fiveLinksSnR : null,
		typeof fiveLinksCost !== 'undefined' ? fiveLinksCost : null,
		typeof fiveLinksQual !== 'undefined' ? fiveLinksQual : null,
		typeof nineLinksTX !== 'undefined' ? nineLinksTX : null,
		typeof nineLinksThp !== 'undefined' ? nineLinksThp : null,
		typeof nineLinksSnR !== 'undefined' ? nineLinksSnR : null,
		typeof nineLinksCost !== 'undefined' ? nineLinksCost : null,
		typeof nineLinksQual !== 'undefined' ? nineLinksQual : null,
		typeof noRFLinks !== 'undefined' ? noRFLinks : null,
		typeof superNodeLinks !== 'undefined' ? superNodeLinks : null
	];
	layers.forEach(function (layer) {
		if (!layer || typeof layer.eachLayer !== 'function') return;
		layer.eachLayer(function (line) {
			if (!line || !line.options || typeof line.setLatLngs !== 'function') return;
			var fromKey = line.options.meshmapFrom;
			var toKey = line.options.meshmapTo;
			if (!fromKey && !toKey) return;
			var latlngs = line.getLatLngs();
			if (!latlngs || latlngs.length < 2) return;
			var a = pos[fromKey] || [latlngs[0].lat, latlngs[0].lng];
			var b = pos[toKey] || [latlngs[1].lat, latlngs[1].lng];
			line.setLatLngs([a, b]);
		});
	});
}

 function createLinks(node, list, nodeLat, nodeLon, layer, linkMetric) {
	var objArray = Object.entries(list);
	var linkColor = "#808080";
	var fromKey = meshmapNodeKey(node);
	function linkOpts(color, opacity, weight, peerHostname, extra) {
		var o = {
			color: color,
			opacity: opacity,
			weight: weight,
			offset: 2,
			meshmapFrom: fromKey,
			meshmapTo: meshmapNodeKey(peerHostname)
		};
		if (extra) {
			Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
		}
		return o;
	}
	function rfPopupHtml(peerHostname, metricText, distanceText, linkInfo) {
		var snrLink = '';
		if (typeof MeshmapSnrCalculator !== 'undefined' && MeshmapSnrCalculator.linkHtmlForSourceAndPeer) {
			snrLink = MeshmapSnrCalculator.linkHtmlForSourceAndPeer(node, peerHostname, linkInfo);
		}
		return "<div class='linkPopupContent'><strong><a href='http://" + peerHostname.toLowerCase() + ".local.mesh' target='_blank'>" + peerHostname.toLowerCase() + "</a></strong> to <strong><a href='http://" + node.toLowerCase() + ".local.mesh' target='_blank'>" + node.toLowerCase() +
			"</a></strong> " + metricText + distanceText + snrLink + "</div>";
	}
	for(var i = 0; i < objArray.length; i++) {
		if(objArray[i][1].linkType === "RF") {
			if(typeof objArray[i][1].linkLat === 'undefined' ||
				objArray[i][1].linkLat === null ||
				nodeLat === 'undefined' ||
				nodeLat === null) {
//					console.log("null values - RF");
					continue;
			}else {
				var distance = "";
				if(mapInfo['kilometers']) {
					distance = " Distance " + objArray[i][1].distanceKM + "km (" + objArray[i][1].distanceMiles + "mi)";
				}else {
					distance = " Distance " + objArray[i][1].distanceMiles + "mi (" + objArray[i][1].distanceKM + "km)";
				}
				var peerHost = objArray[i][1].hostname;
				var linkInfo = objArray[i][1];

				if(linkMetric === "txRate") {
					linkColor = (linkColorsRF_txRate(parseFloat(objArray[i][1].tx_rate, linkMetric)));

					L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
						linkOpts(linkColor, 0.8, 2, peerHost)).bindPopup(
						rfPopupHtml(peerHost, "TX rate: " + objArray[i][1].tx_rate, distance, linkInfo)).addTo(layer);

				}
				if(linkMetric === "Tput") {
					linkColor = (linkColorsRF_txRate(parseFloat(objArray[i][1].expected_throughput, linkMetric)));

					L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
						linkOpts(linkColor, 0.8, 2, peerHost)).bindPopup(
						rfPopupHtml(peerHost, "Expected Throughput: " + objArray[i][1].expected_throughput, distance, linkInfo)).addTo(layer);

				}
				if(linkMetric === "SnR") {
					var SnR = (parseFloat(objArray[i][1].noise) - parseFloat(objArray[i][1].signal)) * -1;
//					console.log(parseFloat(SnR));
					linkColor = linkColorsRF_txRate(SnR, linkMetric);
					SnR = SnR * -1;
					L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
						linkOpts(linkColor, 0.8, 2, peerHost)).bindPopup(
						rfPopupHtml(peerHost, "SnR:" + SnR + " sig: " + objArray[i][1].signal + " noise: " + objArray[i][1].noise, distance, linkInfo)).addTo(layer);
				}
				if(linkMetric === "cost") {
					linkColor = (linkColorRF_cost(objArray[i][1].linkCost));
					L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
                                                linkOpts(linkColor, 0.8, 2, peerHost)).bindPopup(
                                                rfPopupHtml(peerHost, "Link Cost: " + objArray[i][1].linkCost, distance, linkInfo)).addTo(layer);
				}

				if(linkMetric === "qual") {
					linkColor = (linkColorRF_quality(objArray[i][1].linkQuality));
					L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
                                                linkOpts(linkColor, 0.8, 2, peerHost)).bindPopup(
                                                rfPopupHtml(peerHost, "Link Quality: " + objArray[i][1].linkQuality, distance, linkInfo)).addTo(layer);
				}

/*
				if(objArray[i][1].tx_rate >= "40") {
					linkColor = "#00FF00";
				}
				if(objArray[i][1].tx_rate < "40" && objArray[i][1].tx_rate > "11") {
					var val = parseInt(objArray[i][1].tx_rate, 16);
					linkColor = "#" + val + "FF00";
				}
				if(objArray[i][1].tx_rate < "11") {
					linkColor = "#FF0000";
				}
*/
//				console.log("RF LINK! tx_rate: " + objArray[i][1].tx_rate + " = #" + val + "FF00" +
//					" linkLat: " + objArray[i][1].linkLat + " linkLon: " + objArray[i][1].linkLon +
//					" nodeLat: " + nodeLat + " nodeLon: " + nodeLon);
			}
		}
		if(objArray[i][1].linkType === "DTD") {
			if(typeof objArray[i][1].linkLat === 'undefined' ||
				objArray[i][1].linkLat === null ||
				nodeLat === 'undefined' ||
				nodeLat === null) {
//					console.log("null values - DTD");
					continue;
			}else {
				linkColor = "#A020F0";
//				L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
//					{color: linkColor, opacity: 0.2, weight: 2, offset: 2}).addTo(layer);
				if(linkMetric === "supernode") {
					L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
										linkOpts(linkColor, 0.5, 2, objArray[i][1].hostname)).bindPopup(
						                                                "<div class='linkPopupContent'><strong><a href='http://" + objArray[i][1].hostname.toLowerCase() + ".local.mesh' target='_blank'>" + objArray[i][1].hostname.toLowerCase() + "</a></strong> to <strong><a href='http://" + node.toLowerCase() + ".local.mesh' target='_blank'>" + node.toLowerCase() +
						                                                "</a></strong> DTD</div>").addTo(superNodeLinks);
				}else {
					L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
											linkOpts(linkColor, 0.5, 2, objArray[i][1].hostname)).bindPopup(
						                                                "<div class='linkPopupContent'><strong><a href='http://" + objArray[i][1].hostname.toLowerCase() + ".local.mesh' target='_blank'>" + objArray[i][1].hostname.toLowerCase() + "</a></strong> to <strong><a href='http://" + node.toLowerCase() + ".local.mesh' target='_blank'>" + node.toLowerCase() +
						                                                "</a></strong> DTD</div>").addTo(noRFLinks);
				}
			}
		}
		if(objArray[i][1].linkType === "TUN" || objArray[i][1].linkType === "WIREGUARD") {
			linkColor = "steelblue";
			if(typeof objArray[i][1].linkLat === 'undefined' ||
				objArray[i][1].linkLat === null ||
				nodeLat === 'undefined' ||
				nodeLat === null) {
//					console.log("null values - TUN");
					continue;
			}else {
//				L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
//					{color: linkColor, opacity: 0.2, weight: 2, offset: 2}).addTo(layer);
				if(linkMetric === "supernode") {
					L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
										linkOpts(linkColor, 0.5, 2, objArray[i][1].hostname)).bindPopup(
						                                                "<div class='linkPopupContent'><strong><a href='http://" + objArray[i][1].hostname.toLowerCase() + ".local.mesh' target='_blank'>" + objArray[i][1].hostname.toLowerCase() + "</a></strong> to <strong><a href='http://" + node.toLowerCase() + ".local.mesh' target='_blank'>" + node.toLowerCase() +
						                                                "</a></strong> TUN</div>").addTo(superNodeLinks);
				}else {
					L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
											linkOpts(linkColor, 0.5, 2, objArray[i][1].hostname)).bindPopup(
						                                                "<div class='linkPopupContent'><strong><a href='http://" + objArray[i][1].hostname.toLowerCase() + ".local.mesh' target='_blank'>" + objArray[i][1].hostname.toLowerCase() + "</a></strong> to <strong><a href='http://" + node.toLowerCase() + ".local.mesh' target='_blank'>" + node.toLowerCase() +
						                                                "</a></strong> TUN</div>").addTo(noRFLinks);
				}
			}
		}
		if(objArray[i][1].linkType === "XLINK") {
			if(typeof objArray[i][1].linkLat === 'undefined' ||
				objArray[i][1].linkLat === null ||
				nodeLat === 'undefined' ||
				nodeLat === null) {
					continue;
			}else {
				linkColor = "#FF8C00";
				L.polyline([[parseFloat(nodeLat), parseFloat(nodeLon)],[parseFloat(objArray[i][1].linkLat), parseFloat(objArray[i][1].linkLon)]],
					linkOpts(linkColor, 0.8, 3, objArray[i][1].hostname, { dashArray: '8,6' })).bindPopup(
					"<div class='linkPopupContent'><strong><a href='http://" + objArray[i][1].hostname.toLowerCase() + ".local.mesh' target='_blank'>" + objArray[i][1].hostname.toLowerCase() + "</a></strong> to <strong><a href='http://" + node.toLowerCase() + ".local.mesh' target='_blank'>" + node.toLowerCase() +
					"</a></strong> XLINK</div>").addTo(linkMetric === "supernode" ? superNodeLinks : noRFLinks);
			}
		}
		if(!'linkType' in objArray[i][1]) {
			continue;
		}
	}
}
