# Visual Traceroute JSON schema (v1)

Shared by **aredn-traceroute**, **stableroute**, meshinfo `POST /api/v1/trace`, and the Nodographer Visual Traceroute overlay.

```json
{
  "schemaVersion": 1,
  "tool": "aredn-traceroute|stableroute",
  "version": "0.1.x-r0",
  "destination": "nodec",
  "source": "nodea",
  "using": "aredn-traceroute",
  "runs": 10,
  "summary": {
    "uniquePaths": 2,
    "shortest": 3,
    "longest": 3,
    "unreachable": 0,
    "mostCommonCount": 7
  },
  "paths": [
    {
      "index": 1,
      "key": "nodea|nodeb|nodec",
      "count": 7,
      "reached": true,
      "hops": [
        {
          "hop": 1,
          "hostname": "nodea",
          "ip": "10.1.2.3",
          "linkType": "DtD",
          "rttMs": 12,
          "rttAvgMs": 12,
          "rttDevMs": 3,
          "lat": null,
          "lon": null,
          "unreachable": false
        }
      ]
    }
  ]
}
```

- Path identity (`key`) is the ordered hop list of short hostname, else IP, else `*` (RTT / link type do not affect identity).
- Single-run traceroute emits one path with `runs: 1`.
- CLI/CGI: `-json` or `format=json`. Text remains the default for AREDN Tools UI.
