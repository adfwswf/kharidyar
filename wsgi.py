"""WSGI entry point for Render/Gunicorn."""
import os
from app import app, init_db

if not os.environ.get("DATABASE_URL"):
    raise RuntimeError("متغیر DATABASE_URL تنظیم نشده؛ برای جلوگیری از حذف داده‌ها، انتشار متوقف شد.")
if not os.environ.get("FLASK_SECRET_KEY"):
    raise RuntimeError("متغیر FLASK_SECRET_KEY تنظیم نشده است.")

init_db()
