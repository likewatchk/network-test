"""Server/client/network info helpers.

- `get_server_info`: cached lookup of public IP + geolocation via ip-api.com.
- `lookup_ip`: same but for client IPs.
- `run_mtr`: async wrapper around `mtr --json` with a small TTL cache.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import time
from typing import Any

import httpx

IP_API = "http://ip-api.com/json/{ip}?fields=status,country,regionName,city,lat,lon,timezone,isp,org,as,asname,query"

_server_info_cache: dict[str, Any] | None = None
_ip_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_mtr_cache: dict[str, tuple[float, dict[str, Any]]] = {}

IP_CACHE_TTL = 600.0
MTR_CACHE_TTL = 60.0


async def _ip_api_lookup(ip: str | None) -> dict[str, Any]:
    target = ip or ""
    url = IP_API.format(ip=target)
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(url)
            if r.status_code == 200:
                data = r.json()
                if data.get("status") == "success":
                    return data
                return {"status": "fail", "raw": data}
    except Exception as e:  # network blocked, DNS, timeout, etc.
        return {"status": "error", "error": str(e)}
    return {"status": "fail"}


async def lookup_ip(ip: str) -> dict[str, Any]:
    now = time.time()
    cached = _ip_cache.get(ip)
    if cached and now - cached[0] < IP_CACHE_TTL:
        return cached[1]
    data = await _ip_api_lookup(ip)
    _ip_cache[ip] = (now, data)
    return data


async def get_server_info() -> dict[str, Any]:
    global _server_info_cache
    if _server_info_cache is not None:
        return _server_info_cache

    hostname = socket.gethostname()
    started_at = time.time()

    # Try to resolve our own public IP via ip-api (no ip = "the requester's").
    geo = await _ip_api_lookup(None)
    public_ip = geo.get("query") if isinstance(geo, dict) else None

    _server_info_cache = {
        "hostname": hostname,
        "public_ip": public_ip,
        "started_at": started_at,
        "geo": geo,
    }
    return _server_info_cache


async def run_mtr(ip: str, count: int = 3) -> dict[str, Any]:
    if not ip or ip in ("127.0.0.1", "::1", "localhost"):
        return {"status": "skipped", "reason": "loopback"}

    now = time.time()
    cached = _mtr_cache.get(ip)
    if cached and now - cached[0] < MTR_CACHE_TTL:
        return cached[1]

    mtr_bin = None
    for cand in ("/usr/sbin/mtr", "/usr/bin/mtr", "mtr"):
        if cand.startswith("/") and os.path.exists(cand):
            mtr_bin = cand
            break
        if not cand.startswith("/"):
            mtr_bin = cand
            break
    if mtr_bin is None:
        return {"status": "error", "error": "mtr not found"}

    cmd = [mtr_bin, "--json", "--no-dns", "-c", str(count), ip]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15.0)
    except asyncio.TimeoutError:
        return {"status": "error", "error": "mtr timed out"}
    except Exception as e:
        return {"status": "error", "error": f"mtr exec failed: {e}"}

    if proc.returncode != 0:
        return {
            "status": "error",
            "error": f"mtr exit {proc.returncode}",
            "stderr": stderr.decode(errors="replace")[:512],
        }

    try:
        parsed = json.loads(stdout.decode())
    except json.JSONDecodeError as e:
        return {"status": "error", "error": f"json decode: {e}", "raw": stdout[:512].decode(errors="replace")}

    result = {"status": "ok", "report": parsed.get("report", parsed)}
    _mtr_cache[ip] = (now, result)
    return result
