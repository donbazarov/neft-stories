#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
НЕФТЬ · Истории гостей — рабочий прототип.

Сервер на чистой стандартной библиотеке Python (без зависимостей).

Хранилище данных:
    data/db.json       — все истории (текст, ссылка на фото, флаг публикации)
    data/uploads/*     — загруженные фотографии (по одной на историю)

Запуск:
    python server.py
    python server.py --port 8080
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import secrets
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

# --------------------------------------------------------------------------- #
# Конфигурация
# --------------------------------------------------------------------------- #

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"

# Каталог с данными можно вынести на постоянный диск хостинга:
#   NEFT_DATA_DIR=/var/data python server.py
DATA_DIR = Path(os.environ.get("NEFT_DATA_DIR") or (ROOT / "data")).expanduser().resolve()
UPLOADS_DIR = DATA_DIR / "uploads"
DB_FILE = DATA_DIR / "db.json"

MAX_TEXT_LENGTH = 600                        # лимит символов в истории
MAX_PHOTO_BYTES = 5 * 1024 * 1024            # максимальный размер фото (5 МБ)
ALLOWED_PHOTO_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

DATA_URL_RE = re.compile(r"^data:(?P<mime>[\w.+-]+/[\w.+-]+);base64,(?P<data>[A-Za-z0-9+/=\s]+)$")

# Секретный ключ модерации. Можно задать через переменную окружения,
# иначе ключ будет сгенерирован один раз и сохранён в data/db.json.
MODERATION_KEY = os.environ.get("NEFT_MODERATION_KEY", "")

_lock = threading.Lock()   # защищает чтение/запись файла БД


# --------------------------------------------------------------------------- #
# Работа с хранилищем (JSON-файл)
# --------------------------------------------------------------------------- #

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _default_db() -> dict:
    return {"settings": {"moderation_key": MODERATION_KEY or secrets.token_urlsafe(16)}, "stories": []}


def load_db() -> dict:
    """Читает базу. При первом запуске создаёт её."""
    with _lock:
        if not DB_FILE.exists():
            db = _default_db()
            _write_db(db)
            return db
        try:
            with DB_FILE.open("r", encoding="utf-8") as fh:
                db = json.load(fh)
        except (json.JSONDecodeError, OSError):
            # Повреждённый файл — не теряем данные, откладываем его в сторону.
            backup = DB_FILE.with_suffix(f".broken-{int(datetime.now().timestamp())}.json")
            DB_FILE.replace(backup)
            db = _default_db()
            _write_db(db)
            return db

        db.setdefault("settings", {})
        db.setdefault("stories", [])
        if MODERATION_KEY:
            db["settings"]["moderation_key"] = MODERATION_KEY
        elif not db["settings"].get("moderation_key"):
            db["settings"]["moderation_key"] = secrets.token_urlsafe(16)
            _write_db(db)
        return db


def _write_db(db: dict) -> None:
    """Атомарная запись: пишем во временный файл и подменяем."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DB_FILE.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(db, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    tmp.replace(DB_FILE)


def save_db(db: dict) -> None:
    with _lock:
        _write_db(db)


def public_story(story: dict) -> dict:
    """История в том виде, в котором её видит посетитель сайта."""
    return {
        "id": story["id"],
        "text": story["text"],
        "photo": story.get("photo"),
        "createdAt": story["createdAt"],
    }


def moderation_story(story: dict) -> dict:
    """Полная история для страницы модерации."""
    return {
        "id": story["id"],
        "text": story["text"],
        "photo": story.get("photo"),
        "published": bool(story.get("published")),
        "createdAt": story["createdAt"],
        "updatedAt": story.get("updatedAt") or story["createdAt"],
    }


def validate_text(raw: object) -> tuple[str | None, str | None]:
    """Возвращает (текст, ошибка)."""
    if not isinstance(raw, str):
        return None, "Текст истории обязателен"
    text = raw.strip()
    if not text:
        return None, "История не может быть пустой"
    if len(text) > MAX_TEXT_LENGTH:
        return None, f"Слишком длинная история: максимум {MAX_TEXT_LENGTH} символов"
    return text, None


def save_photo(data_url: object) -> tuple[str | None, str | None]:
    """Декодирует data-URL и кладёт картинку в data/uploads.

    Возвращает (публичный путь, ошибка).
    """
    if data_url in (None, ""):
        return None, None
    if not isinstance(data_url, str):
        return None, "Некорректный файл фотографии"

    match = DATA_URL_RE.match(data_url.strip())
    if not match:
        return None, "Некорректный формат фотографии"

    mime = match.group("mime").lower()
    if mime not in ALLOWED_PHOTO_TYPES:
        return None, "Поддерживаются только изображения JPG, PNG, WEBP или GIF"

    try:
        payload = base64.b64decode(match.group("data"), validate=True)
    except (ValueError, TypeError):
        return None, "Не удалось прочитать фотографию"

    if len(payload) > MAX_PHOTO_BYTES:
        return None, f"Фотография слишком большая: максимум {MAX_PHOTO_BYTES // (1024 * 1024)} МБ"

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{ALLOWED_PHOTO_TYPES[mime]}"
    (UPLOADS_DIR / filename).write_bytes(payload)
    return f"/uploads/{filename}", None


def delete_photo(photo_path: str | None) -> None:
    """Удаляет файл фотографии из uploads (если он существует)."""
    if not photo_path or not photo_path.startswith("/uploads/"):
        return
    name = os.path.basename(photo_path)
    target = UPLOADS_DIR / name
    if target.is_file():
        target.unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# HTTP-обработчик
# --------------------------------------------------------------------------- #

class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class NeftHandler(BaseHTTPRequestHandler):
    server_version = "NeftStories/1.0"
    protocol_version = "HTTP/1.1"

    # ---------------------------- утилиты ответа --------------------------- #

    def _send(self, status: int, body: bytes, content_type: str = "application/octet-stream") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json(status, {"error": message})

    def read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "Некорректный запрос")
        if length <= 0:
            return {}
        # Ограничиваем вход, чтобы не принять бесконечное тело.
        if length > 12 * 1024 * 1024:
            raise ApiError(413, "Слишком большой запрос")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "Некорректный JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "Ожидается JSON-объект")
        return data

    # ------------------------------ статика -------------------------------- #

    def serve_static(self, relative_path: str) -> None:
        """Отдаёт файл из public/ (uploads обрабатывается отдельно)."""
        candidate = (PUBLIC_DIR / relative_path.lstrip("/")).resolve()
        try:
            candidate.relative_to(PUBLIC_DIR.resolve())
        except ValueError:
            raise ApiError(403, "Доступ запрещён")
        if not candidate.is_file():
            raise ApiError(404, "Страница не найдена")

        ctype, _ = mimetypes.guess_type(candidate.name)
        if candidate.suffix == ".js":
            ctype = "text/javascript"
        elif candidate.suffix == ".css":
            ctype = "text/css"
        elif candidate.suffix == ".html":
            ctype = "text/html"
        self._send(200, candidate.read_bytes(), f"{ctype or 'application/octet-stream'}; charset=utf-8")

    def serve_upload(self, relative_path: str) -> None:
        name = os.path.basename(relative_path)
        candidate = (UPLOADS_DIR / name).resolve()
        if not candidate.is_file():
            raise ApiError(404, "Файл не найден")
        ctype, _ = mimetypes.guess_type(candidate.name)
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(candidate.stat().st_size))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(candidate.read_bytes())

    # ------------------------------ маршруты ------------------------------- #

    def moderation_key(self) -> str:
        """Ключ из заголовка или query-параметра."""
        header = self.headers.get("X-Moderation-Key")
        if header:
            return header
        query = parse_qs(urlparse(self.path).query)
        return (query.get("key") or [""])[0]

    def require_moderation_key(self) -> None:
        db = load_db()
        expected = db["settings"]["moderation_key"]
        supplied = self.moderation_key()
        if not supplied or not secrets.compare_digest(supplied, expected):
            # Намеренно отдаём 404, чтобы скрытая страница не «светилась».
            raise ApiError(404, "Страница не найдена")

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_HEAD(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def _dispatch(self, method: str) -> None:
        path = unquote(urlparse(self.path).path)
        try:
            handler = self._resolve(method, path)
            if handler is None:
                raise ApiError(404, "Страница не найдена")
            handler(path)
        except ApiError as exc:
            self.send_error_json(exc.status, exc.message)
        except BrokenPipeError:
            pass
        except Exception as exc:  # pragma: no cover - защита от неожиданных ошибок
            sys.stderr.write(f"[error] {method} {path}: {exc}\n")
            self.send_error_json(500, "Внутренняя ошибка сервера")

    def _resolve(self, method: str, path: str):
        if path in ("/", "/index.html"):
            return self._page_index
        if path == "/moderation":
            return self._page_moderation
        if path == "/api/stories" and method == "GET":
            return self._api_public_stories
        if path == "/api/stories" and method == "POST":
            return self._api_create_story
        if path == "/api/moderation/stories" and method == "GET":
            return self._api_moderation_list
        match = re.fullmatch(r"/api/moderation/stories/([A-Za-z0-9_-]+)", path)
        if match and method == "PATCH":
            return lambda _p, story_id=match.group(1): self._api_moderation_update(story_id)
        if path.startswith("/uploads/"):
            return lambda p: self.serve_upload(p)
        if path.startswith("/assets/"):
            return lambda p: self.serve_static(p)
        return None

    # ------------------------------ страницы ------------------------------- #

    def _page_index(self, _path: str) -> None:
        self.serve_static("index.html")

    def _page_moderation(self, _path: str) -> None:
        # Секретная страница: без правильного ключа — 404.
        self.require_moderation_key()
        self.serve_static("moderation.html")

    # ---------------------------- публичный API ---------------------------- #

    def _api_public_stories(self, _path: str) -> None:
        """Только опубликованные истории — для карусели."""
        db = load_db()
        stories = [s for s in db["stories"] if s.get("published")]
        stories.sort(key=lambda s: s.get("createdAt", ""), reverse=True)
        self.send_json(200, {"stories": [public_story(s) for s in stories]})

    def _api_create_story(self, _path: str) -> None:
        """Приём новой истории. Публикуется только после модерации."""
        body = self.read_json_body()

        text, error = validate_text(body.get("text"))
        if error:
            raise ApiError(400, error)

        photo, error = save_photo(body.get("photo"))
        if error:
            raise ApiError(400, error)

        story = {
            "id": uuid.uuid4().hex,
            "text": text,
            "photo": photo,
            "published": False,          # всегда на модерацию
            "createdAt": _now_iso(),
            "updatedAt": None,
        }

        db = load_db()
        db["stories"].insert(0, story)
        save_db(db)
        self.send_json(201, {"ok": True, "id": story["id"]})

    # ----------------------------- API модерации --------------------------- #

    def _api_moderation_list(self, _path: str) -> None:
        self.require_moderation_key()
        db = load_db()
        stories = sorted(db["stories"], key=lambda s: s.get("createdAt", ""), reverse=True)
        self.send_json(200, {"stories": [moderation_story(s) for s in stories]})

    def _api_moderation_update(self, story_id: str) -> None:
        self.require_moderation_key()
        body = self.read_json_body()

        db = load_db()
        story = next((s for s in db["stories"] if s["id"] == story_id), None)
        if story is None:
            raise ApiError(404, "История не найдена")

        if "text" in body:
            text, error = validate_text(body.get("text"))
            if error:
                raise ApiError(400, error)
            story["text"] = text

        if "photo" in body:
            # photo = null  -> удалить фото
            # photo = ""    -> не менять
            # photo = data: -> заменить
            new_photo = body.get("photo")
            if new_photo is None:
                delete_photo(story.get("photo"))
                story["photo"] = None
            elif new_photo != "":
                saved, error = save_photo(new_photo)
                if error:
                    raise ApiError(400, error)
                delete_photo(story.get("photo"))
                story["photo"] = saved

        if "published" in body:
            story["published"] = bool(body.get("published"))

        story["updatedAt"] = _now_iso()
        save_db(db)
        self.send_json(200, {"ok": True, "story": moderation_story(story)})

    # ------------------------------- логирование --------------------------- #

    def log_message(self, fmt: str, *args) -> None:
        # Ключ модерации передаётся в query-строке, поэтому не пишем его в лог:
        # логи хостинга (Render и т.п.) видны всем, у кого есть доступ к панели.
        message = re.sub(r"(key=)[^&\s\"]+", r"\1<скрыт>", fmt % args)
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), message))


# --------------------------------------------------------------------------- #
# Запуск
# --------------------------------------------------------------------------- #

def main() -> None:
    parser = argparse.ArgumentParser(description="Прототип сайта кофейни НЕФТЬ")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    db = load_db()
    key = db["settings"]["moderation_key"]

    server = ThreadingHTTPServer((args.host, args.port), NeftHandler)
    host_label = "localhost" if args.host in ("0.0.0.0", "::") else args.host

    # На публичном хостинге логи видны в панели, поэтому ключ можно скрыть:
    #   NEFT_HIDE_MODERATION_KEY=1
    hide_key = os.environ.get("NEFT_HIDE_MODERATION_KEY", "").lower() in ("1", "true", "yes")
    moderation_url = f"http://{host_label}:{args.port}/moderation"
    moderation_url += "?key=<скрыт, см. NEFT_MODERATION_KEY>" if hide_key else f"?key={key}"

    print("=" * 68)
    print("  НЕФТЬ · Истории гостей — сервер запущен")
    print("=" * 68)
    print(f"  Главная страница : http://{host_label}:{args.port}/")
    print(f"  Модерация        : {moderation_url}")
    print(f"  Каталог данных   : {DATA_DIR}")
    if MODERATION_KEY:
        print("  Ключ модерации   : взят из переменной окружения NEFT_MODERATION_KEY")
    print()
    print("  Ссылку на модерацию не показываем посетителям — это тайный URL.")
    print("  Остановить сервер: Ctrl+C")
    print("=" * 68)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
