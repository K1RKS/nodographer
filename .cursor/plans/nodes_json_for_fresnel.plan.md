---
name: nodes.json additions for Fresnel KML
overview: Fresnel KML's server reads the meshinfo API directly (nodes.json and status.json), so Nodographer needs no new endpoint. Add the far-end position to each link in nodes.json, and document the nodes.json fields other tools rely on as additive-only.
todos:
  - id: link-position
    content: "exporters._json_link: add lat/lon from linkLat/linkLon (null when unknown)"
    status: completed
  - id: tests
    content: "New tests/test_exporters.py: build_json link lat/lon present when known, null otherwise; existing link fields unchanged"
    status: completed
  - id: docs
    content: "README: document nodes.json node and link fields (including the new link lat/lon) and that they only change additively; note Fresnel KML reads nodes.json and status.json from the API"
    status: completed
  - id: verify
    content: "pytest; one poll cycle on the meshinfo host; curl /api/v1/nodes.json and check link lat/lon; curl status.json from the Fresnel server (internal-nginx)"
    status: pending
isProject: false
---

# nodes.json additions for Fresnel KML

Fresnel KML's server fetches mesh nodes server-side and caches them for its users, who only ever reach the Fresnel page. That server can reach the meshinfo API directly, so Fresnel reads:

- `GET /api/v1/nodes.json`, with `If-None-Match` and gzip (about 60 KB gzipped, usually a 304);
- `GET /api/v1/status.json`, when the data looks old, to say why.

Everything Fresnel uses is already in `nodes.json`: `id`, `node`, `lat`/`lon`, the `antenna` block, `meshrf.freq`, `meshrf.chanbw`, `band`, `last_seen`, and RF `links` with `distance_km`, `bearing_deg`, `signal_dbm` and `noise_dbm`. The one gap is the position of a link's far end when that node has no record of its own. The poller knows it as `linkLat`/`linkLon` (from the DB node or the LQM tracker) but doesn't export it. Today that affects 26 link targets in the live feed, and 4 of them have a position the poller learned from LQM.

No `sites.json`, no new API route, and no change to how the public map host gets its data. Proxy mode versus rsync for `meshmap.k1rks.me` is a separate decision about the public map.

## Change (`meshinfo/exporters.py`)

`_json_link(dest_ip, link)` gains two keys:

```python
'lat': _coord(link.get('linkLat')),
'lon': _coord(link.get('linkLon')),
```

`_coord` already turns 0, missing and non-numbers into None. The keys are added for every link type; consumers filter by `linkType`. `nodes.json` keeps `version: "1"`: adding keys doesn't break worldmap-style readers.

## Tests (`meshinfo/tests/test_exporters.py`, new)

There are no exporter tests yet. Start with `build_json`:
- a node whose `link_info` has one RF link with `linkLat`/`linkLon` and one without: the first has `lat`/`lon`, the second has nulls;
- the existing link keys (`hostname`, `id`, `linkType`, `distance_km`, `bearing_deg`, `signal_dbm`, `noise_dbm`) are unchanged.

## Docs (README)

- Under the `nodes.json` export, list the node fields and the link fields, including `lat`/`lon`, with units.
- Say these fields only change additively: new keys may appear; existing keys keep their names, units and meaning.
- In the meshinfo API section, add a short "Reading from another server" note: a server-side consumer such as Fresnel KML should use `If-None-Match` and gzip, and read `status.json` for scan state. `allowOrigins` only matters for browsers.

## Verify

1. `cd meshinfo && venv/bin/python -m pytest`.
2. After one cycle on the meshinfo host, check that links now carry `lat`/`lon`:
   `curl -s localhost:8090/api/v1/nodes.json | jq '[.nodeInfo[].data.links[] | select(.linkType=="RF")][0]'`.
3. From the Fresnel server (`internal-nginx`): `curl -s http://<meshinfo-host>:8090/api/v1/status.json | jq .state` returns a state. If it doesn't connect, the Fresnel plan's deploy step can't use the API yet.
