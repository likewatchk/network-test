"""FastAPI app: routes, websockets, video streaming task."""
from __future__ import annotations

import asyncio
import json
import struct
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .frames import FrameConfig, FrameGenerator, RESOLUTIONS
from .netinfo import get_server_info, lookup_ip, run_mtr

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
INDEX_FILE = STATIC_DIR / "index.html"

app = FastAPI(title="Network Performance Inspector")

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

_frame_gen = FrameGenerator()


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(INDEX_FILE)


def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    if request.client:
        return request.client.host
    return ""


@app.get("/api/server-info")
async def api_server_info() -> dict[str, Any]:
    return await get_server_info()


@app.get("/api/client-info")
async def api_client_info(request: Request) -> dict[str, Any]:
    ip = _client_ip(request)
    geo = await lookup_ip(ip) if ip else {}
    return {
        "client_ip": ip,
        "user_agent": request.headers.get("user-agent", ""),
        "accept_language": request.headers.get("accept-language", ""),
        "headers": dict(request.headers),
        "geo": geo,
        "server_recv_ms": int(time.time() * 1000),
    }


@app.get("/api/traceroute")
async def api_traceroute(request: Request, dest: Optional[str] = None) -> dict[str, Any]:
    ip = dest or _client_ip(request)
    return await run_mtr(ip)


@app.websocket("/ws/ping")
async def ws_ping(ws: WebSocket) -> None:
    await ws.accept()
    try:
        while True:
            msg = await ws.receive_text()
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue
            if data.get("type") == "ping":
                resp = {
                    "type": "pong",
                    "c1": data.get("c1"),
                    "s": time.time() * 1000,
                }
                await ws.send_text(json.dumps(resp))
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await ws.close()
        except Exception:
            pass


def _pack_frame(server_ts_us: int, seq: int, payload: bytes, jpeg_len: int) -> bytes:
    # [8B uint64 server_ts_us][4B uint32 seq][4B uint32 jpeg_len][payload]
    header = struct.pack(">QII", server_ts_us, seq, jpeg_len)
    return header + payload


@app.websocket("/ws/video")
async def ws_video(ws: WebSocket) -> None:
    await ws.accept()
    cfg = FrameConfig()
    config_lock = asyncio.Lock()

    async def reader() -> None:
        try:
            while True:
                msg = await ws.receive_text()
                try:
                    data = json.loads(msg)
                except json.JSONDecodeError:
                    continue
                if data.get("type") == "config":
                    async with config_lock:
                        new_res = data.get("resolution")
                        if isinstance(new_res, str) and new_res in RESOLUTIONS:
                            cfg.resolution = new_res
                        new_fps = data.get("fps")
                        if isinstance(new_fps, (int, float)):
                            cfg.fps = max(1, min(60, int(new_fps)))
                        new_kbps = data.get("target_kbps")
                        if isinstance(new_kbps, (int, float)):
                            cfg.target_kbps = max(50, min(20000, int(new_kbps)))
                        new_q = data.get("jpeg_quality")
                        if isinstance(new_q, (int, float)):
                            cfg.jpeg_quality = max(20, min(95, int(new_q)))
        except WebSocketDisconnect:
            return
        except Exception:
            return

    async def writer() -> None:
        seq = 0
        loop = asyncio.get_running_loop()
        next_t = loop.time()
        try:
            while True:
                async with config_lock:
                    cur = FrameConfig(
                        resolution=cfg.resolution,
                        fps=cfg.fps,
                        target_kbps=cfg.target_kbps,
                        jpeg_quality=cfg.jpeg_quality,
                    )
                server_ts_us = time.time_ns() // 1000
                payload, jpeg_len = await asyncio.to_thread(
                    _frame_gen.render, cur, seq, server_ts_us
                )
                msg = _pack_frame(server_ts_us, seq, payload, jpeg_len)
                await ws.send_bytes(msg)
                seq += 1
                next_t += 1.0 / max(1, cur.fps)
                now = loop.time()
                delay = next_t - now
                if delay > 0:
                    await asyncio.sleep(delay)
                else:
                    # We fell behind — resync the schedule.
                    next_t = now
        except WebSocketDisconnect:
            return
        except Exception:
            return

    reader_task = asyncio.create_task(reader())
    writer_task = asyncio.create_task(writer())
    done, pending = await asyncio.wait(
        {reader_task, writer_task}, return_when=asyncio.FIRST_COMPLETED
    )
    for t in pending:
        t.cancel()
    try:
        await ws.close()
    except Exception:
        pass
