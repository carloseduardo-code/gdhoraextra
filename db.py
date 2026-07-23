"""Usuários e auditoria com suporte a SQLite local e Supabase."""
import os
import json
import sqlite3
from datetime import datetime
from contextlib import contextmanager

from dotenv import load_dotenv
from supabase import create_client, Client
from werkzeug.security import generate_password_hash, check_password_hash

load_dotenv()

DB_PATH = os.path.join(os.path.dirname(__file__), "data", "app.db")
SUPABASE_URL = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = (
    os.getenv("SUPABASE_KEY")
    or os.getenv("SUPABASE_SECRET_KEY")
    or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    or os.getenv("SUPABASE_PUBLISHABLE_KEY")
    or os.getenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
)
SUPABASE_CLIENT: Client | None = None
if SUPABASE_URL and SUPABASE_KEY:
    SUPABASE_CLIENT = create_client(SUPABASE_URL, SUPABASE_KEY)


def _connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    if SUPABASE_CLIENT is not None:
        return
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
                senha_hash TEXT NOT NULL,
                nome TEXT NOT NULL,
                ativo INTEGER NOT NULL DEFAULT 1,
                criado_em TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS auditoria (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario_id INTEGER,
                usuario_nome TEXT NOT NULL,
                acao TEXT NOT NULL,
                entidade TEXT NOT NULL,
                entidade_id TEXT,
                detalhes TEXT,
                criado_em TEXT NOT NULL,
                FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
            );
        """)


def count_usuarios():
    if SUPABASE_CLIENT is not None:
        try:
            res = SUPABASE_CLIENT.table("usuarios").select("id", count="exact").execute()
            return int(getattr(res, "count", None) or len(res.data or []))
        except Exception:
            return 0
    with get_db() as conn:
        row = conn.execute("SELECT COUNT(*) AS c FROM usuarios WHERE ativo = 1").fetchone()
        return int(row["c"])


def criar_usuario(usuario, senha, nome, ativo=True):
    usuario = (usuario or "").strip().lower()
    nome = (nome or "").strip() or usuario
    if not usuario or not senha:
        raise ValueError("Usuário e senha são obrigatórios")
    if len(senha) < 4:
        raise ValueError("Senha deve ter pelo menos 4 caracteres")
    agora = datetime.now().isoformat(timespec="seconds")

    if SUPABASE_CLIENT is not None:
        try:
            existente = SUPABASE_CLIENT.table("usuarios").select("id").ilike("usuario", usuario).execute()
            if existente.data:
                raise ValueError("Este usuário já existe")
        except Exception:
            pass
        payload = {
            "usuario": usuario,
            "senha_hash": generate_password_hash(senha),
            "nome": nome,
            "ativo": bool(ativo),
            "criado_em": agora,
        }
        res = SUPABASE_CLIENT.table("usuarios").insert(payload).execute()
        row = (res.data or [None])[0]
        return row.get("id") if row else None

    with get_db() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO usuarios (usuario, senha_hash, nome, ativo, criado_em) VALUES (?, ?, ?, ?, ?)",
                (usuario, generate_password_hash(senha), nome, 1 if ativo else 0, agora),
            )
            return cur.lastrowid
        except sqlite3.IntegrityError:
            raise ValueError("Este usuário já existe")


def _senha_valida(senha_hash, senha):
    try:
        senha = senha or ""
        senha_hash = senha_hash or ""
        if not senha_hash or not senha:
            return False
        if str(senha_hash).strip() == str(senha).strip():
            return True
        if check_password_hash(senha_hash, senha):
            return True
    except Exception:
        pass
    return False


def autenticar(usuario, senha):
    usuario = (usuario or "").strip().lower()
    if SUPABASE_CLIENT is not None:
        try:
            res = SUPABASE_CLIENT.table("usuarios").select("*").eq("usuario", usuario).execute()
            rows = res.data or []
            if rows:
                row = rows[0]
                if not row or not row.get("ativo", True):
                    return None
                if not _senha_valida(row.get("senha_hash") or "", senha or ""):
                    return None
                return {
                    "id": row.get("id"),
                    "usuario": row.get("usuario"),
                    "nome": row.get("nome"),
                    "ativo": row.get("ativo"),
                    "criado_em": row.get("criado_em"),
                }

            if "@" in usuario:
                try:
                    auth_res = SUPABASE_CLIENT.auth.sign_in_with_password({
                        "email": usuario,
                        "password": senha or "",
                    })
                    user = getattr(auth_res, "user", None)
                    if user:
                        return {
                            "id": getattr(user, "id", None),
                            "usuario": getattr(user, "email", usuario),
                            "nome": getattr(user, "user_metadata", {}).get("name") or getattr(user, "email", usuario),
                            "ativo": True,
                            "criado_em": None,
                        }
                except Exception:
                    pass
            return None
        except Exception:
            return None

    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM usuarios WHERE usuario = ? COLLATE NOCASE AND ativo = 1",
            (usuario,),
        ).fetchone()
    if not row:
        return None
    if not _senha_valida(row["senha_hash"], senha or ""):
        return None
    return dict(row)


def listar_usuarios():
    if SUPABASE_CLIENT is not None:
        try:
            res = SUPABASE_CLIENT.table("usuarios").select("id, usuario, nome, ativo, criado_em").order("usuario").execute()
            return [dict(r) for r in (res.data or [])]
        except Exception:
            return []
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, usuario, nome, ativo, criado_em FROM usuarios ORDER BY usuario"
        ).fetchall()
    return [dict(r) for r in rows]


def atualizar_usuario_status(usuario_id, ativo):
    if SUPABASE_CLIENT is not None:
        try:
            SUPABASE_CLIENT.table("usuarios").update({"ativo": bool(ativo)}).eq("id", usuario_id).execute()
        except Exception:
            pass
        return
    with get_db() as conn:
        conn.execute(
            "UPDATE usuarios SET ativo = ? WHERE id = ?",
            (1 if ativo else 0, usuario_id),
        )


def registrar_auditoria(usuario_id, usuario_nome, acao, entidade, entidade_id=None, detalhes=None):
    agora = datetime.now().isoformat(timespec="seconds")
    det = detalhes
    if det is not None and not isinstance(det, str):
        det = json.dumps(det, ensure_ascii=False, default=str)

    if SUPABASE_CLIENT is not None:
        payload = {
            "usuario_id": usuario_id,
            "usuario_nome": usuario_nome or "desconhecido",
            "acao": acao,
            "entidade": entidade,
            "entidade_id": str(entidade_id) if entidade_id is not None else None,
            "detalhes": det,
            "criado_em": agora,
        }
        try:
            SUPABASE_CLIENT.table("auditoria").insert(payload).execute()
        except Exception:
            pass
        return

    with get_db() as conn:
        conn.execute(
            """INSERT INTO auditoria
               (usuario_id, usuario_nome, acao, entidade, entidade_id, detalhes, criado_em)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                usuario_id,
                usuario_nome or "desconhecido",
                acao,
                entidade,
                str(entidade_id) if entidade_id is not None else None,
                det,
                agora,
            ),
        )


def listar_auditoria(limit=100, entidade=None, entidade_id=None):
    if SUPABASE_CLIENT is not None:
        try:
            query = SUPABASE_CLIENT.table("auditoria").select("*").order("id", desc=True).limit(int(limit))
            if entidade:
                query = query.eq("entidade", entidade)
            if entidade_id is not None:
                query = query.eq("entidade_id", str(entidade_id))
            res = query.execute()
            return [dict(r) for r in (res.data or [])]
        except Exception:
            return []

    sql = "SELECT * FROM auditoria WHERE 1=1"
    params = []
    if entidade:
        sql += " AND entidade = ?"
        params.append(entidade)
    if entidade_id is not None:
        sql += " AND entidade_id = ?"
        params.append(str(entidade_id))
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(int(limit))
    with get_db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


# Inicializa ao importar
init_db()
