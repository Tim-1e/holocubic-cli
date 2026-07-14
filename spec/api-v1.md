# HoloCubic DevTools API v1 Contract

The CLI treats the existing `/devtools/api` service as API v1. The deployed
firmware predates explicit version/capability fields, so the client supports a
strict compatibility fallback while preferring explicit fields when present.

## Handshake

`GET /devtools/api/info`

Required legacy fields:

- `ok: true`
- `root_path: "/sd"`
- `chunk_size`: positive integer
- `max_file_size`: positive integer
- `run_app_id`: string
- `run_app_main`: absolute path below `/sd`

Future-compatible optional fields:

```json
{
  "api_version": 1,
  "capabilities": [
    "fs.list",
    "fs.stat",
    "fs.read",
    "fs.write",
    "fs.mkdir",
    "fs.rename",
    "fs.remove",
    "fs.rmdir",
    "apps.list",
    "devrun.read",
    "devrun.save",
    "devrun.run"
  ]
}
```

When the optional fields are absent, the client derives only the capabilities
implemented by the deployed DevTools v1 routes. It never infers general app
launch or app rescan support.

## Endpoints used by v0.1

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/info` | Handshake and transfer limits |
| GET | `/list?path=` | List one directory |
| GET | `/stat?path=` | Stat one path |
| GET | `/read?path=&offset=&size=` | Read one binary chunk |
| POST | `/mkdir?path=` | Create one directory |
| POST | `/rename?path=&new_path=` | Rename within the SD card |
| PUT | `/upload?path=&offset=&total=` | Write one binary chunk |
| DELETE | `/remove?path=` | Delete one file |
| DELETE | `/rmdir?path=&recursive=` | Delete one directory |
| GET | `/apps` | List editable SD apps |
| GET | `/code/read` | Read DevRun source |
| POST | `/code/save` | Save DevRun source |
| POST | `/code/run` | Save and launch DevRun |

All remote paths are normalized below `/sd`. The client reads transfer limits
from the handshake rather than hard-coding the currently deployed 256 KiB chunk
and 64 MiB file limits.

## Compatibility policy

- Major `api_version` values above 1 are rejected unless explicitly supported.
- New optional response fields are ignored.
- Missing required fields fail the handshake before any mutation.
- Capability checks fail locally before making an unsupported mutating request.
- Device JSON errors are surfaced without exposing authorization or local
  configuration data.
