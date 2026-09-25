"""OpenAI-compatible speech-to-text HTTP server backed by Parakeet."""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import sys
import time

from aiohttp import WSMsgType, web

from parakeet_audio import SAMPLE_RATE, AudioDecodeError, decode_to_mono16k
from parakeet_config import ConfigError, ServerConfig
from parakeet_stream import StreamOptions, StreamSession
from parakeet_text import postprocess

SERVER_VERSION = "0.1.0"
MODEL_ALIASES = {"whisper-1"}
log = logging.getLogger("parakeet.server")

CFG = web.AppKey("cfg", ServerConfig)
ENGINE = web.AppKey("engine", object)
LOCK = web.AppKey("lock", asyncio.Lock)
STARTED = web.AppKey("started", float)
LOADER = web.AppKey("loader", asyncio.Task)
VAD_FACTORY = web.AppKey("vad_factory", object)


class Busy(Exception):
    pass


async def run_transcription(app: web.Application, audio, *, partial: bool) -> str | None:
    """Serialize inference. Partials never wait: they return None if the model is busy."""
    lock, cfg, engine = app[LOCK], app[CFG], app[ENGINE]
    if partial:
        if lock.locked():
            return None
        await lock.acquire()
    else:
        try:
            await asyncio.wait_for(lock.acquire(), timeout=cfg.queue_timeout_s)
        except TimeoutError as exc:
            raise Busy() from exc
    try:
        return await asyncio.get_running_loop().run_in_executor(None, engine.transcribe, audio)
    finally:
        lock.release()


def error(status: int, code: str, message: str, kind: str = "invalid_request_error") -> web.Response:
    return web.json_response({"error": {"message": message, "type": kind, "code": code}}, status=status)


@web.middleware
async def errors_and_auth(request: web.Request, handler):
    cfg = request.app[CFG]
    if request.path.startswith("/v1/") and request.path != "/v1/stream" and cfg.api_key:
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        if not hmac.compare_digest(token.encode(), cfg.api_key.encode()):
            return error(401, "invalid_api_key", "Invalid or missing API key", "authentication_error")
    try:
        return await handler(request)
    except web.HTTPRequestEntityTooLarge:
        return error(413, "file_too_large", f"Upload exceeds {cfg.max_upload_bytes // (1024 * 1024)} MiB")
    except web.HTTPException as exc:
        return error(exc.status, "http_error", exc.reason)


async def health(request: web.Request) -> web.Response:
    engine = request.app[ENGINE]
    body = {
        "status": "ok" if engine.ready else "loading",
        "version": SERVER_VERSION,
        "model": engine.model_id,
        "ready": engine.ready,
        "uptime_s": round(time.time() - request.app[STARTED]),
    }
    return web.json_response(body, status=200 if engine.ready else 503)


async def models(request: web.Request) -> web.Response:
    engine = request.app[ENGINE]
    return web.json_response({"object": "list", "data": [{"id": engine.model_id, "object": "model", "owned_by": "nvidia"}]})


def _bool(value: str | None, default: bool) -> bool:
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


async def transcriptions(request: web.Request) -> web.Response:
    cfg, engine = request.app[CFG], request.app[ENGINE]
    form = await request.post()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "file"):
        return error(400, "missing_file", "Multipart field 'file' is required")
    model = str(form.get("model") or engine.model_id)
    if model != engine.model_id and model not in MODEL_ALIASES:
        return error(400, "model_not_found", f"Unknown model {model!r}; use {engine.model_id!r}")
    try:
        custom_words = json.loads(str(form.get("custom_words") or "[]"))
        if not isinstance(custom_words, list) or not all(isinstance(w, str) for w in custom_words):
            raise ValueError
        threshold = float(form.get("correction_threshold") or 0.18)
    except ValueError:
        return error(400, "invalid_parameter", "custom_words must be a JSON string array; correction_threshold a number")
    if not engine.ready:
        return error(503, "model_loading", "Model is still loading; retry shortly", "server_error")
    try:
        audio = decode_to_mono16k(upload.file.read())
    except AudioDecodeError as exc:
        return error(400, "invalid_audio", str(exc))
    if len(audio) > cfg.max_seconds * SAMPLE_RATE:
        return error(413, "audio_too_long", f"Audio exceeds {cfg.max_seconds} s")
    started = time.perf_counter()
    try:
        raw = await run_transcription(request.app, audio, partial=False) or ""
    except Busy:
        return error(503, "busy", "Server busy; retry shortly", "server_error")
    except Exception as exc:  # engine errors are opaque onnxruntime failures
        log.exception("transcription failed")
        return error(500, "transcription_failed", f"Transcription failed: {exc}", "server_error")
    text = postprocess(raw, custom_words=custom_words, remove_fillers_=_bool(form.get("remove_fillers"), True), threshold=threshold)
    log.info("transcribed %.1fs audio in %.0f ms (%d chars)", len(audio) / SAMPLE_RATE, (time.perf_counter() - started) * 1000, len(text))
    if str(form.get("response_format") or "json") == "text":
        return web.Response(text=text, content_type="text/plain")
    return web.json_response({"text": text})


async def stream(request: web.Request) -> web.WebSocketResponse:
    cfg, engine = request.app[CFG], request.app[ENGINE]
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=1 << 20)
    await ws.prepare(request)

    async def reject(code: int, message: str) -> web.WebSocketResponse:
        await ws.send_json({"type": "error", "message": message})
        await ws.close(code=code, message=message.encode()[:120])
        return ws

    try:
        first = await ws.receive(timeout=10)
    except TimeoutError:
        return await reject(4400, "start message not received")
    try:
        start = first.json() if first.type == WSMsgType.TEXT else {}
    except ValueError:
        start = {}
    if not isinstance(start, dict) or start.get("type") != "start":
        return await reject(4400, "first message must be start")
    if cfg.api_key and not hmac.compare_digest(str(start.get("api_key") or "").encode(), cfg.api_key.encode()):
        return await reject(4401, "Invalid or missing API key")
    if not engine.ready:
        return await reject(4503, "Model is still loading; retry shortly")
    try:
        options = StreamOptions.from_json(start.get("options") or {})
    except ValueError as exc:
        return await reject(4400, str(exc))

    async def emit(msg: dict) -> None:
        if not ws.closed:
            await ws.send_json(msg)

    async def transcribe(audio, partial: bool):
        return await run_transcription(request.app, audio, partial=partial)

    session = StreamSession(options, transcribe=transcribe, vad_prob=request.app[VAD_FACTORY]().prob, emit=emit)
    await ws.send_json({"type": "ready"})
    await session.announce()
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                await session.feed(msg.data)
            elif msg.type == WSMsgType.TEXT:
                try:
                    kind = msg.json().get("type")
                except (ValueError, AttributeError):
                    kind = None
                if kind == "stop":
                    await session.finish("stopped")
            if session.done.is_set():
                break
    finally:
        if not session.done.is_set():
            session.abort()  # client went away: drop queued work
    await ws.close()
    return ws


def create_app(cfg: ServerConfig, engine, *, load_in_background: bool = True, vad_factory=None) -> web.Application:
    app = web.Application(client_max_size=cfg.max_upload_bytes, middlewares=[errors_and_auth])
    app[CFG], app[ENGINE], app[LOCK], app[STARTED] = cfg, engine, asyncio.Lock(), time.time()
    app.router.add_get("/health", health)
    app.router.add_get("/v1/models", models)
    app.router.add_post("/v1/audio/transcriptions", transcriptions)
    app.router.add_get("/v1/stream", stream)
    app[VAD_FACTORY] = vad_factory or (lambda: engine.new_vad())

    if load_in_background:
        async def start_loading(app: web.Application) -> None:
            async def load() -> None:
                try:
                    await asyncio.get_running_loop().run_in_executor(None, engine.load)
                except Exception:
                    log.exception("model load failed")
                    os._exit(1)  # let systemd restart us
            app[LOADER] = asyncio.create_task(load())
        app.on_startup.append(start_loading)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    try:
        cfg = ServerConfig.from_env(os.environ)
    except ConfigError as exc:
        print(f"parakeet-stt: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
    from parakeet_engine import ParakeetEngine

    web.run_app(create_app(cfg, ParakeetEngine(cfg)), host=cfg.host, port=cfg.port, access_log=None)


if __name__ == "__main__":
    main()
