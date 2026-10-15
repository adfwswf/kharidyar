from flask import Flask, request, jsonify, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from contextlib import contextmanager
from pathlib import Path
import sqlite3
try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:  # Allows local SQLite use before PostgreSQL dependencies are installed.
    psycopg2 = None
    RealDictCursor = None

POSTGRES_ERRORS = (psycopg2.Error,) if psycopg2 else ()
POSTGRES_INTEGRITY_ERRORS = (psycopg2.IntegrityError,) if psycopg2 else ()
import secrets
import re
import os

app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data.db"
SECRET_FILE = BASE_DIR / ".flask_secret_key"

if os.environ.get("FLASK_SECRET_KEY"):
    app.secret_key = os.environ["FLASK_SECRET_KEY"]
else:
    if not SECRET_FILE.exists():
        SECRET_FILE.write_text(secrets.token_hex(32), encoding="utf-8")
    app.secret_key = SECRET_FILE.read_text(encoding="utf-8").strip()

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("DATABASE_URL")),
    MAX_CONTENT_LENGTH=5 * 1024 * 1024,
)

TOKEN_SALT = "kharidyar-tab-auth-v1"
TOKEN_MAX_AGE = 30 * 24 * 60 * 60


# =========================================================
# اتصال به پایگاه داده
# =========================================================

class DatabaseCursor:
    """Small compatibility wrapper so the existing SQLite-style routes also work on PostgreSQL."""
    def __init__(self, cursor, lastrowid=None):
        self._cursor = cursor
        self.lastrowid = lastrowid

    def fetchone(self):
        return self._cursor.fetchone()

    def fetchall(self):
        return self._cursor.fetchall()

    def __iter__(self):
        return iter(self._cursor)


class DatabaseConnection:
    def __init__(self, connection, postgres=False):
        self.connection = connection
        self.postgres = postgres

    def _sql(self, sql):
        if not self.postgres:
            return sql
        # Translate SQLite placeholders and case-insensitive comparisons.
        sql = sql.replace('name = ? COLLATE NOCASE', 'LOWER(name) = LOWER(?)')
        sql = re.sub(r'([A-Za-z_][A-Za-z0-9_.]*)\s+COLLATE\s+NOCASE', r'LOWER(\1)', sql, flags=re.I)
        sql = sql.replace('?', '%s')
        sql = sql.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'BIGSERIAL PRIMARY KEY')
        return sql

    def execute(self, sql, params=()):
        if not self.postgres:
            cursor = self.connection.execute(sql, params)
            return DatabaseCursor(cursor, getattr(cursor, 'lastrowid', None))

        prepared = self._sql(sql)
        is_insert = bool(re.match(r'\s*INSERT\s+INTO\s+', prepared, flags=re.I))
        has_returning = bool(re.search(r'\bRETURNING\b', prepared, flags=re.I))
        cursor = self.connection.cursor(cursor_factory=RealDictCursor)
        if is_insert and not has_returning:
            prepared = prepared.rstrip().rstrip(';') + ' RETURNING id'
        cursor.execute(prepared, params)
        inserted_id = None
        if is_insert and not has_returning:
            row = cursor.fetchone()
            if row:
                inserted_id = row.get('id')
        return DatabaseCursor(cursor, inserted_id)

    def executescript(self, script):
        if not self.postgres:
            self.connection.executescript(script)
            return
        # The initialization script contains ordinary DDL statements separated by semicolons.
        for statement in script.split(';'):
            statement = statement.strip()
            if statement:
                self.execute(statement)

    def commit(self):
        self.connection.commit()

    def rollback(self):
        self.connection.rollback()

    def close(self):
        self.connection.close()


@contextmanager
def get_db():
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if database_url:
        if psycopg2 is None:
            raise RuntimeError("برای اتصال به PostgreSQL باید psycopg2-binary نصب باشد.")
        raw_db = psycopg2.connect(database_url, connect_timeout=15)
        db = DatabaseConnection(raw_db, postgres=True)
    else:
        raw_db = sqlite3.connect(DB_PATH, timeout=10)
        raw_db.row_factory = sqlite3.Row
        raw_db.execute("PRAGMA foreign_keys = ON")
        db = DatabaseConnection(raw_db, postgres=False)

    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def error(message, status=400):
    return jsonify({
        "success": False,
        "message": message,
    }), status


def table_columns(db, table_name):
    if db.postgres:
        rows = db.execute(
            "SELECT column_name AS name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = ?",
            (table_name,),
        ).fetchall()
    else:
        rows = db.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {row["name"] for row in rows}


# =========================================================
# احراز هویت مخصوص هر تب
# =========================================================

def create_tab_token(member_id):
    serializer = URLSafeTimedSerializer(
        app.secret_key,
        salt=TOKEN_SALT,
    )
    return serializer.dumps({
        "member_id": int(member_id),
    })


def get_tab_member_id():
    authorization = request.headers.get("Authorization", "")

    if not authorization.startswith("Bearer "):
        return None

    token = authorization[7:].strip()

    if not token:
        return None

    serializer = URLSafeTimedSerializer(
        app.secret_key,
        salt=TOKEN_SALT,
    )

    try:
        data = serializer.loads(
            token,
            max_age=TOKEN_MAX_AGE,
        )
        return int(data["member_id"])

    except (
        BadSignature,
        SignatureExpired,
        ValueError,
        TypeError,
        KeyError,
    ):
        return None


def generate_member_code(db):
    for _ in range(100):
        code = f"{secrets.randbelow(1_000_000):06d}"

        exists = db.execute("""
            SELECT 1
            FROM members
            WHERE member_code = ?
        """, (code,)).fetchone()

        if not exists:
            return code

    raise RuntimeError("ساخت کد عضویت یکتا ممکن نشد.")


def generate_replacement_code(db, old_code):
    for _ in range(100):
        code = f"{secrets.randbelow(1_000_000):06d}"

        exists = db.execute("""
            SELECT 1
            FROM members
            WHERE member_code = ?
        """, (code,)).fetchone()

        if not exists and code != old_code:
            return code

    raise RuntimeError("تولید کد جدید ممکن نشد.")


# =========================================================
# ساخت و به‌روزرسانی پایگاه داده
# اطلاعات قبلی حذف نمی‌شوند.
# =========================================================

def init_db():
    with get_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS families (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                family_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                gender TEXT NOT NULL,
                role TEXT NOT NULL,
                member_code TEXT NOT NULL UNIQUE,
                is_approver INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (family_id) REFERENCES families(id)
                    ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                family_id INTEGER,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                image_path TEXT,
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (family_id) REFERENCES families(id)
                    ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS shopping_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                family_id INTEGER NOT NULL,
                product_id INTEGER,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                quantity INTEGER NOT NULL DEFAULT 1,
                done INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (family_id) REFERENCES families(id)
                    ON DELETE CASCADE,
                FOREIGN KEY (product_id) REFERENCES products(id)
                    ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS approval_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                family_id INTEGER NOT NULL,
                request_type TEXT NOT NULL,
                product_id INTEGER,
                item_id INTEGER,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                requested_by INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                reviewed_by INTEGER,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                image_path TEXT,
                FOREIGN KEY (family_id) REFERENCES families(id)
                    ON DELETE CASCADE
            );
        """)

        # به‌روزرسانی جدول اعضا بدون حذف اطلاعات قبلی
        members_columns = table_columns(db, "members")

        if "is_approver" not in members_columns:
            db.execute("""
                ALTER TABLE members
                ADD COLUMN is_approver INTEGER NOT NULL DEFAULT 0
            """)

        members_columns = table_columns(db, "members")

        if "username" not in members_columns:
            db.execute("""
                ALTER TABLE members ADD COLUMN username TEXT
            """)

        if "password_hash" not in members_columns:
            db.execute("""
                ALTER TABLE members ADD COLUMN password_hash TEXT
            """)

        if "activated" not in members_columns:
            db.execute("""
                ALTER TABLE members
                ADD COLUMN activated INTEGER NOT NULL DEFAULT 0
            """)

        # به‌روزرسانی جدول درخواست‌ها
        request_columns = table_columns(db, "approval_requests")

        if "image_path" not in request_columns:
            db.execute("""
                ALTER TABLE approval_requests
                ADD COLUMN image_path TEXT
            """)

        if "old_name" not in request_columns:
            db.execute("""
                ALTER TABLE approval_requests
                ADD COLUMN old_name TEXT
            """)

        if "old_description" not in request_columns:
            db.execute("""
                ALTER TABLE approval_requests
                ADD COLUMN old_description TEXT
            """)

        # ایندکس‌ها
        db.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_members_username_unique
            ON members(username)
            WHERE username IS NOT NULL
        """)

        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_members_family
            ON members(family_id)
        """)

        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_products_family
            ON products(family_id)
        """)

        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_items_family
            ON shopping_items(family_id)
        """)

        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_requests_family_status
            ON approval_requests(family_id, status)
        """)

        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_requests_requester
            ON approval_requests(family_id, requested_by)
        """)

        # کالاهای پیش‌فرض فقط در صورت نبودن اضافه می‌شوند.
        default_products = [
            ("نان سنگک", "نان سنگک", "bread-sangak.png"),
            ("نان بربری", "نان بربری", "bread-barbari.png"),
            ("نان تافتون", "نان تافتون", ""),
            ("نان باگت", "نان باگت", ""),
            ("ماست", "ماست", ""),
        ]

        for name, description, image_path in default_products:
            exists = db.execute("""
                SELECT id
                FROM products
                WHERE is_default = 1 AND name = ?
                LIMIT 1
            """, (name,)).fetchone()

            if not exists:
                db.execute("""
                    INSERT INTO products
                    (family_id, name, description, image_path, is_default)
                    VALUES (NULL, ?, ?, ?, 1)
                """, (
                    name,
                    description,
                    image_path or "",
                ))


# =========================================================
# اطلاعات اعضا و دسترسی خانواده
# =========================================================

def current_member(db, family_id=None):
    member_id = get_tab_member_id()

    if not member_id:
        return None

    if family_id is None:
        return db.execute("""
            SELECT m.*, f.name AS family_name
            FROM members m
            JOIN families f ON f.id = m.family_id
            WHERE m.id = ? AND m.activated = 1
        """, (member_id,)).fetchone()

    return db.execute("""
        SELECT m.*, f.name AS family_name
        FROM members m
        JOIN families f ON f.id = m.family_id
        WHERE m.id = ?
          AND m.family_id = ?
          AND m.activated = 1
    """, (member_id, family_id)).fetchone()


def authorize_family(db, family_id):
    return current_member(db, family_id)


def member_public_data(member):
    return {
        "id": member["id"],
        "name": member["name"],
        "gender": member["gender"],
        "role": member["role"],
        "isApprover": bool(member["is_approver"]),
        "username": member["username"],
    }


def family_members_data(db, family_id):
    rows = db.execute("""
        SELECT id, name, gender, role, is_approver, username
        FROM members
        WHERE family_id = ?
        ORDER BY id
    """, (family_id,)).fetchall()

    return [{
        "id": row["id"],
        "name": row["name"],
        "gender": row["gender"],
        "role": row["role"],
        "isApprover": bool(row["is_approver"]),
        "username": row["username"],
    } for row in rows]


def account_response(db, member):
    return jsonify({
        "success": True,
        "family_id": member["family_id"],
        "familyName": member["family_name"],
        "member": member_public_data(member),
        "familyMembers": family_members_data(
            db,
            member["family_id"],
        ),
    })


def valid_username(username):
    return bool(
        isinstance(username, str)
        and re.fullmatch(r"[A-Za-z0-9_.-]{3,24}", username)
    )


def valid_password(password):
    return isinstance(password, str) and 8 <= len(password) <= 128


def login_response(db, member):
    updated = db.execute("""
        SELECT m.*, f.name AS family_name
        FROM members m
        JOIN families f ON f.id = m.family_id
        WHERE m.id = ?
    """, (member["id"],)).fetchone()

    return jsonify({
        "success": True,
        "family_id": updated["family_id"],
        "familyName": updated["family_name"],
        "member": member_public_data(updated),
        "familyMembers": family_members_data(
            db,
            updated["family_id"],
        ),
        "tabToken": create_tab_token(updated["id"]),
    })


# =========================================================
# صفحات سایت
# =========================================================

@app.errorhandler(413)
def too_large(_error):
    return jsonify({
        "success": False,
        "message": "حجم فایل یا درخواست بیش از حد مجاز است.",
    }), 413


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/style.css")
def style():
    return send_from_directory(BASE_DIR, "style.css")


@app.route("/script.js")
def javascript():
    return send_from_directory(BASE_DIR, "script.js")


@app.get("/api/test")
def test_api():
    return jsonify({
        "success": True,
        "message": "سرور فعال است.",
    })


# =========================================================
# ساخت خانواده
# =========================================================

@app.post("/api/families")
def create_family():
    data = request.get_json(silent=True) or {}

    family_name = str(data.get("familyName", "")).strip()
    members = data.get("members")

    if not family_name or len(family_name) > 50:
        return error("نام خانواده باید بین ۱ تا ۵۰ نویسه باشد.")

    if not isinstance(members, list) or not 2 <= len(members) <= 20:
        return error("تعداد اعضا باید بین ۲ تا ۲۰ نفر باشد.")

    normalized = []
    approver_count = 0

    for item in members:
        if not isinstance(item, dict):
            return error("اطلاعات یکی از اعضا معتبر نیست.")

        name = str(item.get("name", "")).strip()
        gender = item.get("gender")
        role = item.get("role")
        is_approver = bool(item.get("isApprover", False))

        if not name or len(name) > 40:
            return error("نام هر عضو باید بین ۱ تا ۴۰ نویسه باشد.")

        if gender not in ("مرد", "زن"):
            return error("جنسیت انتخاب‌شده معتبر نیست.")

        if role not in ("پدر", "مادر", "فرزند", "سایر اعضا"):
            return error("نقش انتخاب‌شده معتبر نیست.")

        if role == "پدر" and gender != "مرد":
            return error("جنسیت پدر باید مرد باشد.")

        if role == "مادر" and gender != "زن":
            return error("جنسیت مادر باید زن باشد.")

        approver_count += int(is_approver)

        normalized.append({
            "name": name,
            "gender": gender,
            "role": role,
            "is_approver": is_approver,
        })

    if approver_count < 1:
        return error(
            "حداقل یک عضو باید اجازهٔ تأیید درخواست‌ها داشته باشد."
        )

    try:
        with get_db() as db:
            cursor = db.execute(
                "INSERT INTO families (name) VALUES (?)",
                (family_name,),
            )

            family_id = cursor.lastrowid
            created_members = []

            for member in normalized:
                code = generate_member_code(db)

                cursor = db.execute("""
                    INSERT INTO members
                    (
                        family_id, name, gender, role,
                        member_code, is_approver, activated
                    )
                    VALUES (?, ?, ?, ?, ?, ?, 0)
                """, (
                    family_id,
                    member["name"],
                    member["gender"],
                    member["role"],
                    code,
                    int(member["is_approver"]),
                ))

                created_members.append({
                    "id": cursor.lastrowid,
                    "name": member["name"],
                    "gender": member["gender"],
                    "role": member["role"],
                    "isApprover": member["is_approver"],
                    "code": code,
                })

            return jsonify({
                "success": True,
                "family": {
                    "id": family_id,
                    "name": family_name,
                },
                "members": created_members,
            }), 201

    except (sqlite3.Error,) + POSTGRES_ERRORS:
        app.logger.exception("خطا در ساخت خانواده")
        return error(
            "ساخت خانواده انجام نشد. دوباره تلاش کنید.",
            500,
        )


# =========================================================
# اولین فعال‌سازی حساب
# =========================================================

@app.post("/api/activate")
def activate_account():
    data = request.get_json(silent=True) or {}

    code = str(data.get("code", "")).strip()
    username = str(data.get("username", "")).strip()
    password = data.get("password")

    if not re.fullmatch(r"\d{6}", code):
        return error("کد عضویت باید ۶ رقم باشد.")

    if not valid_username(username):
        return error(
            "نام کاربری باید ۳ تا ۲۴ نویسه و شامل حروف انگلیسی، "
            "عدد، نقطه، خط تیره یا زیرخط باشد."
        )

    if not valid_password(password):
        return error(
            "رمز عبور باید حداقل ۸ و حداکثر ۱۲۸ نویسه باشد."
        )

    try:
        with get_db() as db:
            member = db.execute("""
                SELECT *
                FROM members
                WHERE member_code = ?
            """, (code,)).fetchone()

            if not member:
                return error(
                    "کد عضویت معتبر نیست یا قبلاً استفاده شده است.",
                    404,
                )

            if member["activated"]:
                return error(
                    "این کد قبلاً فعال شده است. "
                    "با نام کاربری و رمز وارد شوید.",
                    409,
                )

            username_exists = db.execute("""
                SELECT id
                FROM members
                WHERE username = ?
            """, (username,)).fetchone()

            if username_exists:
                return error(
                    "این نام کاربری قبلاً انتخاب شده است.",
                    409,
                )

            password_hash = generate_password_hash(password)
            new_code = generate_replacement_code(db, code)

            db.execute("""
                UPDATE members
                SET username = ?,
                    password_hash = ?,
                    activated = 1,
                    member_code = ?
                WHERE id = ? AND activated = 0
            """, (
                username,
                password_hash,
                new_code,
                member["id"],
            ))

            updated = db.execute("""
                SELECT m.*, f.name AS family_name
                FROM members m
                JOIN families f ON f.id = m.family_id
                WHERE m.id = ?
            """, (member["id"],)).fetchone()

            return jsonify({
                "success": True,
                "family_id": updated["family_id"],
                "familyName": updated["family_name"],
                "member": member_public_data(updated),
                "familyMembers": family_members_data(
                    db,
                    updated["family_id"],
                ),
                "tabToken": create_tab_token(updated["id"]),
            })

    except (sqlite3.IntegrityError,) + POSTGRES_INTEGRITY_ERRORS:
        return error(
            "این نام کاربری قبلاً استفاده شده است.",
            409,
        )

    except (sqlite3.Error,) + POSTGRES_ERRORS:
        app.logger.exception("خطا در فعال‌سازی حساب")
        return error("فعال‌سازی حساب انجام نشد.", 500)


# =========================================================
# ورود و خروج
# =========================================================

@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}

    username = str(data.get("username", "")).strip()
    password = data.get("password")

    if not username or not isinstance(password, str):
        return error("نام کاربری و رمز عبور را وارد کنید.")

    with get_db() as db:
        member = db.execute("""
            SELECT *
            FROM members
            WHERE username = ? AND activated = 1
        """, (username,)).fetchone()

        if (
            not member
            or not member["password_hash"]
            or not check_password_hash(
                member["password_hash"],
                password,
            )
        ):
            return error(
                "نام کاربری یا رمز عبور اشتباه است.",
                401,
            )

        return login_response(db, member)


@app.post("/api/logout")
def logout():
    return jsonify({
        "success": True,
        "message": "از حساب خارج شدید.",
    })


# =========================================================
# تنظیمات حساب
# =========================================================

@app.route("/api/account", methods=["GET", "PATCH"])
def account():
    if request.method == "GET":
        with get_db() as db:
            member = current_member(db)

            if not member:
                return error("ابتدا وارد حساب شوید.", 401)

            return account_response(db, member)

    data = request.get_json(silent=True) or {}

    name = str(data.get("name", "")).strip()
    new_username = str(data.get("username", "")).strip()
    new_password = data.get("password")

    with get_db() as db:
        member = current_member(db)

        if not member:
            return error("ابتدا وارد حساب شوید.", 401)

        if "name" in data:
            if not name or len(name) > 40:
                return error(
                    "نام نمایشی باید بین ۱ تا ۴۰ نویسه باشد."
                )

            db.execute("""
                UPDATE members
                SET name = ?
                WHERE id = ?
            """, (name, member["id"]))

        if "username" in data:
            if not valid_username(new_username):
                return error("نام کاربری واردشده معتبر نیست.")

            duplicate = db.execute("""
                SELECT id
                FROM members
                WHERE username = ? AND id != ?
            """, (
                new_username,
                member["id"],
            )).fetchone()

            if duplicate:
                return error(
                    "این نام کاربری قبلاً انتخاب شده است.",
                    409,
                )

            db.execute("""
                UPDATE members
                SET username = ?
                WHERE id = ?
            """, (
                new_username,
                member["id"],
            ))

        if "password" in data and new_password:
            if not valid_password(new_password):
                return error(
                    "رمز عبور باید حداقل ۸ و حداکثر ۱۲۸ نویسه باشد."
                )

            db.execute("""
                UPDATE members
                SET password_hash = ?
                WHERE id = ?
            """, (
                generate_password_hash(new_password),
                member["id"],
            ))

        updated = current_member(db)

        return jsonify({
            "success": True,
            "family_id": updated["family_id"],
            "familyName": updated["family_name"],
            "member": member_public_data(updated),
            "familyMembers": family_members_data(
                db,
                updated["family_id"],
            ),
        })


@app.post("/api/change-password")
def change_password():
    data = request.get_json(silent=True) or {}

    new_password = data.get("password")
    confirm_password = data.get("confirmPassword")

    if not valid_password(new_password):
        return error(
            "رمز عبور باید حداقل ۸ و حداکثر ۱۲۸ نویسه باشد."
        )

    if new_password != confirm_password:
        return error(
            "رمز عبور جدید و تکرار آن یکسان نیستند."
        )

    with get_db() as db:
        member = current_member(db)

        if not member:
            return error("ابتدا وارد حساب شوید.", 401)

        db.execute("""
            UPDATE members
            SET password_hash = ?
            WHERE id = ?
        """, (
            generate_password_hash(new_password),
            member["id"],
        ))

        return jsonify({
            "success": True,
            "message": "رمز عبور با موفقیت تغییر کرد.",
        })


# =========================================================
# کالاهای خانواده
# =========================================================

@app.route(
    "/api/families/<int:family_id>/products",
    methods=["GET", "POST"],
)
def family_products(family_id):
    with get_db() as db:
        member = authorize_family(db, family_id)

        if not member:
            return error(
                "برای انجام این کار باید وارد خانواده شوید.",
                401,
            )

        # دریافت کالاها
        if request.method == "GET":
            rows = db.execute("""
                SELECT *
                FROM products
                WHERE is_default = 1 OR family_id = ?
                ORDER BY is_default DESC, name COLLATE NOCASE
            """, (family_id,)).fetchall()

            return jsonify({
                "success": True,
                "products": [{
                    "id": row["id"],
                    "family_id": row["family_id"],
                    "name": row["name"],
                    "description": row["description"] or "",
                    "image_path": row["image_path"] or "",
                    "is_default": bool(row["is_default"]),
                } for row in rows],
            })

        # دریافت اطلاعات کالای جدید
        data = request.get_json(silent=True) or {}

        name = str(data.get("name", "")).strip()
        description = str(data.get("description", "")).strip()

        if not name or len(name) > 80:
            return error(
                "نام کالا باید بین ۱ تا ۸۰ نویسه باشد."
            )

        if not description or len(description) > 500:
            return error(
                "توضیح کالا را وارد کنید؛ حداکثر ۵۰۰ نویسه."
            )

        # جلوگیری از کالای تکراری در همان خانواده
        duplicate = db.execute("""
            SELECT id
            FROM products
            WHERE family_id = ?
              AND name = ? COLLATE NOCASE
        """, (family_id, name)).fetchone()

        if duplicate:
            return error(
                "این کالا قبلاً در کالاهای خانواده وجود دارد."
            )

        # تأییدکننده: ثبت مستقیم کالا
        if member["is_approver"]:
            cursor = db.execute("""
                INSERT INTO products (
                    family_id,
                    name,
                    description,
                    image_path,
                    is_default
                )
                VALUES (?, ?, ?, ?, 0)
            """, (
                family_id,
                name,
                description,
                "",
            ))

            product_id = cursor.lastrowid

            db.execute("""
                INSERT INTO shopping_items (
                    family_id,
                    product_id,
                    name,
                    description,
                    quantity,
                    done
                )
                VALUES (?, ?, ?, ?, 1, 0)
            """, (
                family_id,
                product_id,
                name,
                description,
            ))

            return jsonify({
                "success": True,
                "approved": True,
                "productId": product_id,
                "message": "کالا مستقیماً به فهرست خرید اضافه شد.",
            }), 201

        # عضو عادی: ارسال درخواست برای تأیید
        cursor = db.execute("""
            INSERT INTO approval_requests (
                family_id,
                request_type,
                name,
                description,
                requested_by,
                status,
                image_path
            )
            VALUES (?, 'add_product', ?, ?, ?, 'pending', ?)
        """, (
            family_id,
            name,
            description,
            member["id"],
            "",
        ))

        return jsonify({
            "success": True,
            "approved": False,
            "requestId": cursor.lastrowid,
            "message": "درخواست افزودن کالا برای تأیید ارسال شد.",
        }), 201
# =========================================================
# فهرست خرید
# =========================================================

@app.route("/manifest.json")
def manifest():
    return send_from_directory(BASE_DIR, "manifest.json",
                               mimetype="application/manifest+json")

@app.route("/service-worker.js")
def service_worker():
    response = send_from_directory(BASE_DIR, "service-worker.js")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response

@app.route("/icon-192.png")
def icon_192():
    return send_from_directory(BASE_DIR, "icon-192.png")

@app.route("/icon-512.png")
def icon_512():
    return send_from_directory(BASE_DIR, "icon-512.png")

@app.route(
    "/api/families/<int:family_id>/shopping-items",
    methods=["GET", "POST"],
)
def family_shopping_items(family_id):
    with get_db() as db:
        member = authorize_family(db, family_id)

        if not member:
            return error(
                "برای انجام این کار باید وارد خانواده شوید.",
                401,
            )

        if request.method == "GET":
            rows = db.execute("""
                SELECT *
                FROM shopping_items
                WHERE family_id = ?
                ORDER BY done ASC, id DESC
            """, (family_id,)).fetchall()

            return jsonify({
                "success": True,
                "items": [{
                    "id": row["id"],
                    "family_id": row["family_id"],
                    "product_id": row["product_id"],
                    "name": row["name"],
                    "description": row["description"] or "",
                    "quantity": row["quantity"],
                    "done": bool(row["done"]),
                } for row in rows],
            })

        data = request.get_json(silent=True) or {}

        try:
            product_id = int(data.get("productId"))
            quantity = int(data.get("quantity", 1))
        except (TypeError, ValueError):
            return error("کالا یا تعداد معتبر نیست.")

        if not 1 <= quantity <= 999:
            return error("تعداد باید بین ۱ تا ۹۹۹ باشد.")

        product = db.execute("""
            SELECT *
            FROM products
            WHERE id = ?
              AND (is_default = 1 OR family_id = ?)
        """, (
            product_id,
            family_id,
        )).fetchone()

        if not product:
            return error(
                "کالای انتخاب‌شده پیدا نشد.",
                404,
            )

        # تأییدکننده کالا را مستقیماً به فهرست خرید اضافه می‌کند.
        if member["is_approver"]:
            cursor = db.execute("""
                INSERT INTO shopping_items
                (
                    family_id, product_id, name,
                    description, quantity, done
                )
                VALUES (?, ?, ?, '', ?, 0)
            """, (
                family_id,
                product["id"],
                product["name"],
                quantity,
            ))

            return jsonify({
                "success": True,
                "approved": True,
                "itemId": cursor.lastrowid,
                "message": "کالا مستقیماً به فهرست خرید اضافه شد.",
            }), 201

        # عضو عادی باید درخواست تأیید ثبت کند.
        cursor = db.execute("""
            INSERT INTO approval_requests
            (
                family_id, request_type, product_id,
                name, description, requested_by,
                status, image_path
            )
            VALUES (?, 'add_item', ?, ?, ?, ?, 'pending', ?)
        """, (
            family_id,
            product["id"],
            product["name"],
            f"تعداد درخواستی: {quantity}",
            member["id"],
            "",
        ))

        return jsonify({
            "success": True,
            "approved": False,
            "requestId": cursor.lastrowid,
            "message": (
                "درخواست افزودن کالا به فهرست برای تأیید ارسال شد."
            ),
        }), 201# =========================================================
# ویرایش کالا، تعداد و وضعیت خرید
# =========================================================

@app.patch(
    "/api/families/<int:family_id>/shopping-items/<int:item_id>"
)
def update_shopping_item(family_id, item_id):
    data = request.get_json(silent=True) or {}

    with get_db() as db:
        member = authorize_family(db, family_id)

        if not member:
            return error(
                "برای انجام این کار باید وارد خانواده شوید.",
                401,
            )

        item = db.execute("""
            SELECT *
            FROM shopping_items
            WHERE id = ? AND family_id = ?
        """, (
            item_id,
            family_id,
        )).fetchone()

        if not item:
            return error(
                "مورد فهرست پیدا نشد.",
                404,
            )

        # درخواست ویرایش عنوان یا توضیحات
        if "name" in data or "description" in data:
            name = str(
                data.get("name", item["name"])
            ).strip()

            description = str(
                data.get(
                    "description",
                    item["description"] or "",
                )
            ).strip()

            if not name or len(name) > 80:
                return error(
                    "عنوان کالا باید بین ۱ تا ۸۰ نویسه باشد."
                )

            if len(description) > 500:
                return error(
                    "توضیحات حداکثر می‌تواند ۵۰۰ نویسه باشد."
                )

            # تأییدکننده می‌تواند مستقیم ویرایش کند.
            if member["is_approver"]:
                db.execute("""
                    UPDATE shopping_items
                    SET name = ?, description = ?
                    WHERE id = ? AND family_id = ?
                """, (
                    name,
                    description,
                    item_id,
                    family_id,
                ))

                return jsonify({
                    "success": True,
                    "approved": True,
                    "message": "کالا ویرایش شد.",
                })

            # عضو عادی درخواست ویرایش ثبت می‌کند.
            cursor = db.execute("""
                INSERT INTO approval_requests
                (
                    family_id, request_type, item_id,
                    name, description, old_name,
                    old_description, requested_by, status
                )
                VALUES (?, 'edit_item', ?, ?, ?, ?, ?, ?, 'pending')
            """, (
                family_id,
                item_id,
                name,
                description,
                item["name"],
                item["description"] or "",
                member["id"],
            ))

            return jsonify({
                "success": True,
                "approved": False,
                "requestId": cursor.lastrowid,
                "message": (
                    "درخواست ویرایش برای تأیید ارسال شد."
                ),
            }), 201

        # تغییر وضعیت خرید
        updates = []
        values = []

        if "done" in data:
            if not isinstance(data["done"], bool):
                return error("وضعیت خرید معتبر نیست.")

            updates.append("done = ?")
            values.append(1 if data["done"] else 0)

        # تغییر تعداد
        if "quantity" in data:
            try:
                quantity = int(data["quantity"])
            except (TypeError, ValueError):
                return error("تعداد معتبر نیست.")

            if not 1 <= quantity <= 999:
                return error(
                    "تعداد باید بین ۱ تا ۹۹۹ باشد."
                )

            updates.append("quantity = ?")
            values.append(quantity)

        if not updates:
            return error(
                "تغییری برای ذخیره ارسال نشده است."
            )

        values.extend([item_id, family_id])

        db.execute(
            f"UPDATE shopping_items SET {', '.join(updates)} "
            "WHERE id = ? AND family_id = ?",
            values,
        )

        return jsonify({
            "success": True,
            "message": "مورد به‌روزرسانی شد.",
        })


# =========================================================
# حذف کالا از فهرست خرید
# =========================================================

@app.delete(
    "/api/families/<int:family_id>/shopping-items/<int:item_id>"
)
def delete_shopping_item(family_id, item_id):
    with get_db() as db:
        member = authorize_family(db, family_id)

        if not member:
            return error(
                "برای انجام این کار باید وارد خانواده شوید.",
                401,
            )

        item = db.execute("""
            SELECT *
            FROM shopping_items
            WHERE id = ? AND family_id = ?
        """, (
            item_id,
            family_id,
        )).fetchone()

        if not item:
            return error(
                "مورد فهرست پیدا نشد.",
                404,
            )

        # تأییدکننده حذف مستقیم انجام می‌دهد.
        if member["is_approver"]:
            db.execute("""
                DELETE FROM shopping_items
                WHERE id = ? AND family_id = ?
            """, (
                item_id,
                family_id,
            ))

            return jsonify({
                "success": True,
                "approved": True,
                "message": "مورد حذف شد.",
            })

        # عضو عادی درخواست حذف می‌فرستد.
        db.execute("""
            INSERT INTO approval_requests
            (
                family_id, request_type, item_id,
                name, description, requested_by,
                status, image_path
            )
            VALUES (?, 'delete_item', ?, ?, ?, ?, 'pending', ?)
        """, (
            family_id,
            item_id,
            item["name"],
            item["description"] or "",
            member["id"],
            "",
        ))

        return jsonify({
            "success": True,
            "approved": False,
            "message": "درخواست حذف برای تأیید ارسال شد.",
        }), 201


# =========================================================
# درخواست‌های در انتظار تأیید
# مخصوص اعضای تأییدکننده
# =========================================================

@app.get("/api/families/<int:family_id>/requests")
def get_requests(family_id):
    with get_db() as db:
        member = authorize_family(db, family_id)

        if not member:
            return error(
                "برای انجام این کار باید وارد خانواده شوید.",
                401,
            )

        if not member["is_approver"]:
            return error(
                "شما اجازهٔ بررسی درخواست‌ها را ندارید.",
                403,
            )

        rows = db.execute("""
            SELECT
                r.*,
                requester.name AS requester_name,
                requester.role AS requester_role,
                reviewer.name AS reviewer_name
            FROM approval_requests r
            LEFT JOIN members requester
                ON requester.id = r.requested_by
            LEFT JOIN members reviewer
                ON reviewer.id = r.reviewed_by
            WHERE r.family_id = ?
              AND r.status = 'pending'
            ORDER BY r.id DESC
        """, (family_id,)).fetchall()

        return jsonify({
            "success": True,
            "requests": [{
                "id": row["id"],
                "family_id": row["family_id"],
                "request_type": row["request_type"],
                "product_id": row["product_id"],
                "item_id": row["item_id"],
                "name": row["name"],
                "description": row["description"] or "",
                "old_name": row["old_name"] or "",
                "old_description": row["old_description"] or "",
                "requester_name": (
                    row["requester_name"] or "عضو خانواده"
                ),
                "requester_role": row["requester_role"] or "",
                "reviewer_name": row["reviewer_name"] or "",
                "status": row["status"],
                "image_path": row["image_path"] or "",
            } for row in rows],
        })


# =========================================================
# درخواست‌های من
# برای هر عضو خانواده
# =========================================================

@app.get("/api/families/<int:family_id>/my-requests")
def get_my_requests(family_id):
    with get_db() as db:
        member = authorize_family(db, family_id)

        if not member:
            return error(
                "برای انجام این کار باید وارد خانواده شوید.",
                401,
            )

        rows = db.execute("""
            SELECT
                r.*,
                requester.name AS requester_name,
                requester.role AS requester_role,
                reviewer.name AS reviewer_name
            FROM approval_requests r
            LEFT JOIN members requester
                ON requester.id = r.requested_by
            LEFT JOIN members reviewer
                ON reviewer.id = r.reviewed_by
            WHERE r.family_id = ?
              AND r.requested_by = ?
            ORDER BY r.id DESC
        """, (
            family_id,
            member["id"],
        )).fetchall()

        return jsonify({
            "success": True,
            "requests": [{
                "id": row["id"],
                "request_type": row["request_type"],
                "product_id": row["product_id"],
                "item_id": row["item_id"],
                "name": row["name"],
                "description": row["description"] or "",
                "old_name": row["old_name"] or "",
                "old_description": row["old_description"] or "",
                "requester_name": (
                    row["requester_name"] or "عضو خانواده"
                ),
                "requester_role": row["requester_role"] or "",
                "reviewer_name": row["reviewer_name"] or "",
                "status": row["status"],
            } for row in rows],
        })


# =========================================================
# تأیید یا رد درخواست
# =========================================================

@app.post(
    "/api/families/<int:family_id>/requests/<int:request_id>/review"
)
def review_request(family_id, request_id):
    data = request.get_json(silent=True) or {}
    approve = data.get("approve")

    if not isinstance(approve, bool):
        return error(
            "وضعیت تأیید درخواست معتبر نیست."
        )

    with get_db() as db:
        member = authorize_family(db, family_id)

        if not member:
            return error(
                "برای انجام این کار باید وارد خانواده شوید.",
                401,
            )

        if not member["is_approver"]:
            return error(
                "شما اجازهٔ بررسی درخواست‌ها را ندارید.",
                403,
            )

        row = db.execute("""
            SELECT *
            FROM approval_requests
            WHERE id = ?
            AND family_id = ?
            AND status = 'pending'
        """, (
            request_id,
            family_id,
        )).fetchone()

        if not row:
            return error(
                "درخواست پیدا نشد یا قبلاً بررسی شده است.",
                404,
            )

        if approve:
            request_type = row["request_type"]

            # ---------------------------------------------
            # تأیید افزودن کالا به کاتالوگ
            # ---------------------------------------------
            if request_type == "add_product":
                # بررسی می‌کنیم کالا از قبل وجود نداشته باشد.
                product = db.execute("""
                    SELECT id
                    FROM products
                    WHERE family_id = ?
                    AND name = ? COLLATE NOCASE
                    LIMIT 1
                """, (
                    family_id,
                    row["name"],
                )).fetchone()

                if product:
                    product_id = product["id"]
                else:
                    cursor = db.execute("""
                        INSERT INTO products
                        (
                            family_id, name, description,
                            image_path, is_default
                        )
                        VALUES (?, ?, ?, ?, 0)
                    """, (
                        family_id,
                        row["name"],
                        row["description"] or "",
                        row["image_path"] or "",
                    ))

                    product_id = cursor.lastrowid

                # پس از تأیید، کالا واقعاً به فهرست خرید هم اضافه می‌شود.
                db.execute("""
                    INSERT INTO shopping_items
                    (
                        family_id, product_id, name,
                        description, quantity, done
                    )
                    VALUES (?, ?, ?, ?, 1, 0)
                """, (
                    family_id,
                    product_id,
                    row["name"],
                    row["description"] or "",
                ))
            # ---------------------------------------------
            # تأیید افزودن کالا به فهرست خرید
            # ---------------------------------------------
            elif request_type == "add_item":
                quantity_match = re.search(
                    r"تعداد درخواستی:\s*(\d+)",
                    row["description"] or "",
                )

                quantity = (
                    int(quantity_match.group(1))
                    if quantity_match
                    else 1
                )

                quantity = max(1, min(quantity, 999))

                product = db.execute("""
                    SELECT id
                    FROM products
                    WHERE id = ?
                    AND (is_default = 1 OR family_id = ?)
                """, (
                    row["product_id"],
                    family_id,
                )).fetchone()

                if not product:
                    return error(
                        "کالای مربوط به این درخواست پیدا نشد.",
                        404,
                    )

                db.execute("""
                    INSERT INTO shopping_items
                    (
                        family_id, product_id, name,
                        description, quantity, done
                    )
                    VALUES (?, ?, ?, '', ?, 0)
                """, (
                    family_id,
                    product["id"],
                    row["name"],
                    quantity,
                ))

            # ---------------------------------------------
            # تأیید حذف از فهرست خرید
            # ---------------------------------------------
            elif request_type == "delete_item":
                db.execute("""
                    DELETE FROM shopping_items
                    WHERE id = ? AND family_id = ?
                """, (
                    row["item_id"],
                    family_id,
                ))

            # ---------------------------------------------
            # تأیید حذف کالای خانواده
            # ---------------------------------------------
            elif request_type == "delete_product":
                db.execute("""
                    DELETE FROM products
                    WHERE id = ?
                    AND family_id = ?
                    AND is_default = 0
                """, (
                    row["product_id"],
                    family_id,
                ))

            # ---------------------------------------------
            # تأیید ویرایش عنوان و توضیحات
            # ---------------------------------------------
            elif request_type == "edit_item":
                item = db.execute("""
                    SELECT id
                    FROM shopping_items
                    WHERE id = ? AND family_id = ?
                """, (
                    row["item_id"],
                    family_id,
                )).fetchone()

                if not item:
                    return error(
                        "این کالا دیگر در فهرست خرید وجود ندارد.",
                        404,
                    )

                db.execute("""
                    UPDATE shopping_items
                    SET name = ?, description = ?
                    WHERE id = ? AND family_id = ?
                """, (
                    row["name"],
                    row["description"] or "",
                    row["item_id"],
                    family_id,
                ))

            else:
                return error(
                    "نوع درخواست شناخته‌شده نیست."
                )

        # ثبت نتیجهٔ بررسی
        db.execute("""
            UPDATE approval_requests
            SET status = ?, reviewed_by = ?
            WHERE id = ?
            AND family_id = ?
            AND status = 'pending'
        """, (
            "approved" if approve else "rejected",
            member["id"],
            request_id,
            family_id,
        ))

        return jsonify({
            "success": True,
            "message": (
                "درخواست تأیید شد."
                if approve
                else "درخواست رد شد."
            ),
        })


# =========================================================
# حذف کالا از فهرست کالاهای خانواده
# =========================================================

@app.delete(
    "/api/families/<int:family_id>/products/<int:product_id>"
)
def delete_product(family_id, product_id):
    with get_db() as db:
        member = authorize_family(db, family_id)

        if not member:
            return error(
                "برای انجام این کار باید وارد خانواده شوید.",
                401,
            )

        product = db.execute("""
            SELECT *
            FROM products
            WHERE id = ?
              AND family_id = ?
              AND is_default = 0
        """, (
            product_id,
            family_id,
        )).fetchone()

        if not product:
            return error(
                "کالای خانواده پیدا نشد.",
                404,
            )

        if member["is_approver"]:
            db.execute("""
                DELETE FROM products
                WHERE id = ? AND family_id = ?
            """, (
                product_id,
                family_id,
            ))

            return jsonify({
                "success": True,
                "approved": True,
                "message": "کالا حذف شد.",
            })

        db.execute("""
            INSERT INTO approval_requests
            (
                family_id, request_type, product_id,
                name, description, requested_by,
                status, image_path
            )
            VALUES (?, 'delete_product', ?, ?, ?, ?, 'pending', ?)
        """, (
            family_id,
            product_id,
            product["name"],
            product["description"] or "",
            member["id"],
            "",
        ))

        return jsonify({
            "success": True,
            "approved": False,
            "message": "درخواست حذف کالا برای تأیید ارسال شد.",
        }), 201


# =========================================================
# اجرای برنامه
# =========================================================

if __name__ == "__main__":
    init_db()

    with get_db() as db:
        print("\n--- بررسی فهرست خرید ---")

        shopping_rows = db.execute("""
            SELECT id, family_id, product_id, name, quantity, done
            FROM shopping_items
            ORDER BY id DESC
            LIMIT 20
        """).fetchall()

        for row in shopping_rows:
            print(dict(row))

        if not shopping_rows:
            print("فهرست خرید خالی است.")

        print("\n--- بررسی درخواست‌ها ---")

        request_rows = db.execute("""
            SELECT id, family_id, request_type, name, status,
                   product_id, requested_by
            FROM approval_requests
            ORDER BY id DESC
            LIMIT 20
        """).fetchall()

        for row in request_rows:
            print(dict(row))

        if not request_rows:
            print("هیچ درخواستی پیدا نشد.")

        print("\n--- پایان بررسی ---\n")

    print("خریدیار در حال اجراست: http://127.0.0.1:5000")

    app.run(debug=True)
