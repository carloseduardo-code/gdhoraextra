import os
import json
import re
from datetime import datetime
from functools import wraps
from io import BytesIO
import base64

from flask import (
    Flask, request, jsonify, render_template,
    session, redirect, url_for, flash
)
from supabase import create_client, Client
from dotenv import load_dotenv
import pandas as pd

import db as auth_db

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "hora-extra-dev-secret")

supabase_url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
supabase_key = (
    os.getenv("SUPABASE_KEY")
    or os.getenv("SUPABASE_SECRET_KEY")
    or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    or os.getenv("SUPABASE_PUBLISHABLE_KEY")
    or os.getenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
)
supabase: Client | None = None
if supabase_url and supabase_key:
    supabase = create_client(supabase_url, supabase_key)


# ------------------- HELPERS -------------------
def usuario_logado():
    if not session.get("user_id"):
        return None
    return {
        "id": session.get("user_id"),
        "usuario": session.get("user_login"),
        "nome": session.get("user_nome") or session.get("user_login"),
    }


def usuario_master():
    user = usuario_logado()
    return bool(user and str(user.get("usuario") or "").strip().lower() == "kadu")


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("admin_login", next=request.path))
        return f(*args, **kwargs)
    return decorated


def api_admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({"error": "Não autorizado"}), 401
        return f(*args, **kwargs)
    return decorated


def auditar(acao, entidade, entidade_id=None, detalhes=None):
    u = usuario_logado() or {}
    auth_db.registrar_auditoria(
        u.get("id"),
        u.get("nome") or u.get("usuario") or "sistema",
        acao,
        entidade,
        entidade_id,
        detalhes,
    )


def formatar_data_br(data_iso):
    try:
        return datetime.strptime(data_iso, "%Y-%m-%d").strftime("%d/%m/%Y")
    except Exception:
        return data_iso or ""


def extrair_codigo_curto(valor):
    """Extrai código curto tipo ED-2012KS-01 de um texto AS ou equipamento."""
    if not valor:
        return ""
    m = re.search(r"([A-Z]{1,4}-\d[\w\-/]*)", valor.upper())
    if m:
        return m.group(1)
    # AS_023-ED-2012KS-01 → tenta após hífen
    if "-" in valor:
        partes = valor.split("-", 1)
        if len(partes) > 1 and partes[1].strip():
            rest = partes[1].strip()
            m2 = re.search(r"([A-Z]{1,4}-\d[\w\-/]*)", rest.upper())
            if m2:
                return m2.group(1)
            return rest.split()[0] if rest.split() else rest
    return valor


def normalizar_colaborador(c):
    """Aceita string antiga ou objeto {matricula, nome, a_procura, descricao}."""
    if isinstance(c, str):
        return {"matricula": "", "nome": c, "a_procura": False}
    if not isinstance(c, dict):
        return {"matricula": "", "nome": str(c), "a_procura": False}
    return {
        "matricula": str(c.get("matricula") or "").strip(),
        "nome": str(c.get("nome") or c.get("descricao") or "").strip(),
        "a_procura": bool(c.get("a_procura")),
        "descricao": str(c.get("descricao") or "").strip(),
    }


def linha_colaborador(c):
    c = normalizar_colaborador(c)
    if c.get("a_procura"):
        desc = c.get("descricao") or c.get("nome") or "vaga"
        qtd = c.get("matricula") or "01"
        return f"{qtd} - {desc} (À procura...)"
    mat = c.get("matricula") or ""
    nome = c.get("nome") or ""
    if mat and nome:
        return f"{mat} - {nome}"
    return nome or mat


def gerar_resumo(sol, itens):
    data_br = formatar_data_br(sol.get("data_solicitacao"))
    ref = sol.get("equipamento") or extrair_codigo_curto(sol.get("as_code") or "")
    titulo = f"HE {data_br} - {ref}".strip(" -")

    linhas = [titulo, ""]
    for item in itens:
        tipo = item.get("tipo") or "funcao"
        cols = [normalizar_colaborador(c) for c in (item.get("colaboradores") or [])]
        qtd = item.get("quantidade") or len(cols) or 1
        qtd_fmt = f"{int(qtd):02d}" if int(qtd) < 100 else str(int(qtd))

        if tipo == "equipamento":
            eq = (item.get("equipamento") or item.get("funcao") or "").upper()
            linhas.append(eq)
            for c in cols:
                linhas.append(linha_colaborador(c))
            if not cols:
                linhas.append("01 - Operador (À procura...)")
            linhas.append("")
            continue

        funcao = (item.get("funcao") or "").upper()
        if len(cols) == 1 and not cols[0].get("a_procura"):
            linhas.append(funcao)
            linhas.append(linha_colaborador(cols[0]))
        else:
            linhas.append(f"{funcao} ({qtd_fmt})")
            for c in cols:
                linhas.append(linha_colaborador(c))
        linhas.append("")

    if sol.get("observacao"):
        linhas.append("Observação:")
        linhas.append(sol.get("observacao") or "")
    return "\n".join(linhas).rstrip() + "\n"


def gerar_resumo_admin(sol, itens):
    data_br = formatar_data_br(sol.get("data_solicitacao"))
    ref = sol.get("equipamento") or extrair_codigo_curto(sol.get("as_code") or "")
    titulo = f"HE {data_br} - {ref}".strip(" -")
    linhas = [titulo, ""]
    for item in itens:
        if (item.get("tipo") or "funcao") == "equipamento":
            eq = (item.get("equipamento") or item.get("funcao") or "").upper()
            qtd = int(item.get("quantidade") or len(item.get("colaboradores") or []) or 1)
            qtd_fmt = f"{qtd:02d}" if qtd < 100 else str(qtd)
            linhas.append(f"{eq}: {qtd_fmt}")
            continue
        funcao = (item.get("funcao") or "").upper()
        qtd = int(item.get("quantidade") or 0)
        qtd_fmt = f"{qtd:02d}" if qtd < 100 else str(qtd)
        linhas.append(f"{funcao}: {qtd_fmt}")
    if sol.get("observacao"):
        linhas.append("")
        linhas.append("Observação:")
        linhas.append(sol.get("observacao") or "")
    return "\n".join(linhas)


DEFAULT_CAMPOS = [
    {"id": 0, "chave": "solicitante", "label": "Solicitante", "tipo": "efetivo", "obrigatorio": True, "ordem": 10, "ativo": True, "lista_grupo": None},
    {"id": 0, "chave": "setor_solicitante", "label": "Setor Solicitante", "tipo": "select", "obrigatorio": True, "ordem": 20, "ativo": True, "lista_grupo": "setor_solicitante"},
    {"id": 0, "chave": "as_code", "label": "AS (Área de Serviço)", "tipo": "select", "obrigatorio": True, "ordem": 40, "ativo": True, "lista_grupo": "as_code"},
    {"id": 0, "chave": "data_solicitacao", "label": "Data da solicitação", "tipo": "date", "obrigatorio": True, "ordem": 50, "ativo": True, "lista_grupo": None},
    {"id": 0, "chave": "turno", "label": "Turno", "tipo": "radio", "obrigatorio": True, "ordem": 60, "ativo": True, "lista_grupo": "turno"},
    {"id": 0, "chave": "funcoes", "label": "Funções e Colaboradores", "tipo": "funcoes", "obrigatorio": True, "ordem": 70, "ativo": True, "lista_grupo": None},
]

DEFAULT_OPCOES = {
    "setor_solicitante": [
        "QUALIDADE", "SEGURANÇA", "TRANSPORTE", "PLANEJAMENTO",
        "ALMOXERIFADO", "MEIO AMBIENTE", "SAUDE", "PRODUÇÃO",
    ],
    "equipamento": [
        "ED-2012KS-01", "TR-2012KS-11", "TR-2036KS-23",
        "CT-2020KS-04", "TR-2091KS-01", "TR-2011KS-15",
        "Basculante", "Retroescavadeira",
    ],
    "as_code": [
        "AS_005 - EQUIPE ADMINISTRATIVA",
        "AS_006 - APOIO A PRODUÇÃO",
        "AS_015-BRITAGEM SECUNDARIA",
        "AS_017-TR-2012KS-11/TR-2036KS-23",
        "AS_018-CT-2020KS-04",
        "AS_020 - SERVIÇOS EXTRAORDINARIOS",
        "AS_021-TR-2091KS-01/02/03",
        "AS_022-ARMAÇÃO - CORTE E DOBRA",
        "AS_023-ED-2012KS-01",
        "AS_024-APOIO OPERACIONAL",
        "AS_025-TR-2011KS-15",
        "Outros",
    ],
    "turno": ["Dia", "Noite", "Extensão de Horário"],
}

GRUPOS_CONFIG = ("equipamento", "setor_solicitante", "as_code")
OPCOES_PATH = os.path.join(os.path.dirname(__file__), "data", "opcoes.json")


def carregar_opcoes_arquivo():
    """Lê opções editáveis (equipamento, setor, AS) do arquivo local."""
    try:
        if os.path.exists(OPCOES_PATH):
            with open(OPCOES_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                # Mescla com defaults para garantir chaves
                merged = {**DEFAULT_OPCOES, **data}
                return merged
    except Exception:
        pass
    return dict(DEFAULT_OPCOES)


def salvar_opcoes_arquivo(data):
    os.makedirs(os.path.dirname(OPCOES_PATH), exist_ok=True)
    with open(OPCOES_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _opcoes_para_api(raw=None):
    raw = raw or carregar_opcoes_arquivo()
    resultado = {}
    for g, vals in raw.items():
        resultado[g] = [
            {"id": i, "valor": v, "label": v, "ordem": i, "ativo": True}
            for i, v in enumerate(vals, 1)
            if str(v).strip()
        ]
    # Garante Outros em AS
    as_opts = resultado.setdefault("as_code", [])
    if not any(str(o.get("valor", "")).lower() == "outros" for o in as_opts):
        as_opts.append({
            "id": len(as_opts) + 1,
            "valor": "Outros",
            "label": "Outros",
            "ordem": len(as_opts) + 1,
            "ativo": True,
        })
    return resultado


def carregar_formulario_config():
    """Campos fixos + opções editáveis, priorizando o arquivo local de configuração."""
    opcoes = _opcoes_para_api(carregar_opcoes_arquivo())
    campos = DEFAULT_CAMPOS
    fonte = "arquivo"

    if supabase is not None:
        try:
            campos_res = supabase.table("form_campos").select("*").order("ordem").execute()
            campos = []
            for row in campos_res.data or []:
                campos.append({
                    "id": row.get("id"),
                    "chave": row.get("chave"),
                    "label": row.get("label"),
                    "tipo": row.get("tipo"),
                    "obrigatorio": row.get("obrigatorio", True),
                    "ordem": row.get("ordem", 0),
                    "ativo": row.get("ativo", True),
                    "lista_grupo": row.get("lista_grupo"),
                })
            if campos:
                fonte = "supabase-campos"
        except Exception:
            campos = DEFAULT_CAMPOS

    return {
        "campos": campos,
        "opcoes": opcoes,
        "fonte": fonte,
    }


# ------------------- ÁREA PÚBLICA -------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/solicitacao")
def solicitacao():
    return render_template("solicitacao.html")


@app.route("/solicitacao/<int:sol_id>/resumo")
def solicitacao_resumo(sol_id):
    return render_template("resumo.html", solicitacao_id=sol_id)


# ------------------- ÁREA ADMIN -------------------
@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if session.get("user_id"):
        return redirect(url_for("admin_home"))

    erro = None

    if request.method == "POST":
        usuario = (request.form.get("usuario") or "").strip()
        senha = (request.form.get("senha") or "").strip()

        if not usuario or not senha:
            erro = "Informe usuário e senha."
        else:
            user = auth_db.autenticar(usuario, senha)
            if user:
                session["user_id"] = user["id"]
                session["user_login"] = user["usuario"]
                session["user_nome"] = user["nome"]
                auditar("login", "usuario", user["id"])
                nxt = request.args.get("next") or url_for("admin_home")
                return redirect(nxt)
            erro = "Usuário ou senha incorretos."

    return render_template(
        "admin/login.html",
        erro=erro,
        precisa_cadastro=False,
    )


@app.route("/admin/logout")
def admin_logout():
    if session.get("user_id"):
        auditar("logout", "usuario", session.get("user_id"))
    session.clear()
    return redirect(url_for("index"))


@app.route("/admin")
@admin_required
def admin_home():
    return render_template("admin/index.html", user=usuario_logado())


@app.route("/admin/solicitacoes")
@admin_required
def admin_solicitacoes():
    return render_template("admin/solicitacoes.html", user=usuario_logado())


@app.route("/admin/efetivo")
@admin_required
def admin_efetivo():
    return render_template("admin/efetivo.html", user=usuario_logado())


@app.route("/admin/config")
@admin_required
def admin_config():
    return render_template("admin/config.html", user=usuario_logado())


@app.route("/admin/usuarios", methods=["GET", "POST"])
@admin_required
def admin_usuarios():
    erro = None
    ok = None
    master = usuario_master()
    if request.method == "POST":
        action = request.form.get("action") or "create"
        if action == "aprovar":
            if not master:
                erro = "Apenas o usuário mestre pode aprovar novos acessos."
            else:
                try:
                    usuario_id = int(request.form.get("usuario_id"))
                    auth_db.atualizar_usuario_status(usuario_id, True)
                    auditar("aprovar", "usuario", usuario_id, {
                        "aprovado_por": usuario_logado().get("usuario"),
                    })
                    ok = "Usuário aprovado com sucesso."
                except Exception as e:
                    erro = str(e)
        else:
            try:
                ativo = master
                uid = auth_db.criar_usuario(
                    request.form.get("usuario"),
                    request.form.get("senha"),
                    request.form.get("nome"),
                    ativo=ativo,
                )
                auditar("cadastro", "usuario", uid, {
                    "usuario": request.form.get("usuario"),
                    "criado_por": usuario_logado().get("usuario"),
                    "ativo": ativo,
                })
                if master:
                    ok = "Usuário cadastrado com sucesso."
                else:
                    ok = "Usuário cadastrado como pendente. Aguarde aprovação do mestre."
            except ValueError as e:
                erro = str(e)
    return render_template(
        "admin/usuarios.html",
        user=usuario_logado(),
        usuarios=auth_db.listar_usuarios(),
        erro=erro,
        ok=ok,
        is_master=master,
    )


@app.route("/admin/auditoria")
@admin_required
def admin_auditoria():
    return render_template(
        "admin/auditoria.html",
        user=usuario_logado(),
        logs=auth_db.listar_auditoria(limit=200),
    )


# ------------------- API PÚBLICA: FORMULÁRIO -------------------
@app.route("/api/formulario", methods=["GET"])
def get_formulario():
    try:
        return jsonify(carregar_formulario_config())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/funcoes", methods=["GET"])
def get_funcoes():
    try:
        res = supabase.table("funcionarios").select("funcao").execute()
        funcoes = sorted({row["funcao"] for row in res.data if row.get("funcao")})
        return jsonify(funcoes)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/colaboradores", methods=["GET"])
def get_colaboradores():
    funcao = request.args.get("funcao")
    q = (request.args.get("q") or "").strip().lower()
    try:
        query = supabase.table("funcionarios").select("matricula, nome, funcao")
        if funcao:
            query = query.eq("funcao", funcao)
        res = query.order("nome").execute()
        rows = res.data or []
        if q:
            rows = [
                r for r in rows
                if q in (r.get("matricula") or "").lower() or q in (r.get("nome") or "").lower()
            ]
        return jsonify(rows)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/solicitacoes", methods=["POST"])
def create_solicitacao():
    data = request.get_json() or {}
    solicitante = (data.get("solicitante") or "").strip()
    setor_solicitante = (data.get("setor_solicitante") or data.get("setor") or "").strip()
    equipamento = (data.get("equipamento") or "").strip()
    as_code = (data.get("as_code") or data.get("as") or "").strip()
    if (as_code or "").lower() == "outros":
        as_code = (data.get("as_code_outros") or "").strip()
    data_solicitacao = data.get("data_solicitacao") or data.get("data")
    turno = data.get("turno")
    observacao = (data.get("observacao") or "").strip()
    itens = data.get("itens", [])
    equipamentos = data.get("equipamentos", [])

    if not data_solicitacao:
        return jsonify({"error": "Data da solicitação é obrigatória"}), 400

    try:
        # Normaliza itens de função
        itens_norm = []
        for item in itens:
            cols_raw = item.get("colaboradores") or []
            cols = [normalizar_colaborador(c) for c in cols_raw]
            if not cols:
                continue
            qtd = int(item.get("quantidade") or len(cols))
            itens_norm.append({
                "funcao": item.get("funcao"),
                "quantidade": qtd,
                "colaboradores": cols,
                "tipo": "funcao",
            })

        # Normaliza equipamentos → itens do tipo equipamento
        for eq in equipamentos or []:
            nome_eq = (eq.get("equipamento") or "").strip()
            if not nome_eq:
                continue
            cols = []
            op = eq.get("operador")
            if op:
                cols.append(normalizar_colaborador(op))
            for c in eq.get("colaboradores") or []:
                cols.append(normalizar_colaborador(c))
            # dedupe
            seen = set()
            cols_uniq = []
            for c in cols:
                key = (c.get("matricula"), c.get("nome"), c.get("a_procura"))
                if key in seen:
                    continue
                seen.add(key)
                cols_uniq.append(c)
            itens_norm.append({
                "funcao": nome_eq,
                "equipamento": nome_eq,
                "quantidade": max(1, len(cols_uniq)),
                "colaboradores": cols_uniq,
                "tipo": "equipamento",
            })
            if not equipamento:
                equipamento = nome_eq

        if not itens_norm:
            return jsonify({
                "error": "Adicione ao menos uma função com colaboradores ou um equipamento com operador"
            }), 400

        meta = {
            "solicitante": solicitante or None,
            "setor": setor_solicitante or None,
            "setor_solicitante": setor_solicitante or None,
            "equipamento": equipamento or None,
            "as_code": as_code or None,
            "data_solicitacao": data_solicitacao,
            "turno": turno,
            "observacao": observacao or None,
        }
        resumo = gerar_resumo(meta, itens_norm)
        resumo_admin = gerar_resumo_admin(meta, itens_norm)

        sol_payload = {
            "setor": setor_solicitante or as_code or "N/A",
            "as_code": as_code or equipamento or "N/A",
            "data_solicitacao": data_solicitacao,
            "turno": turno or "Dia",
        }
        extras = {
            "solicitante": solicitante or None,
            "setor_solicitante": setor_solicitante or None,
            "equipamento": equipamento or None,
            "observacao": observacao or None,
            "resumo_texto": resumo,
            "resumo_admin": resumo_admin,
        }

        try:
            sol_res = supabase.table("solicitacoes").insert({**sol_payload, **extras}).execute()
        except Exception:
            sol_res = supabase.table("solicitacoes").insert(sol_payload).execute()

        solicitacao_id = sol_res.data[0]["id"]

        for item in itens_norm:
            supabase.table("solicitacao_itens").insert({
                "solicitacao_id": solicitacao_id,
                "funcao": item["funcao"],
                "quantidade": item["quantidade"],
                "colaboradores": item["colaboradores"],
            }).execute()

        # Registra auditoria
        auditar("criar", "solicitacao", solicitacao_id, {
            "solicitante": solicitante or None,
            "setor": setor_solicitante or None,
            "as_code": as_code or None,
            "equipamento": equipamento or None,
            "data_solicitacao": data_solicitacao,
            "turno": turno,
            "itens": len(itens_norm),
        })

        return jsonify({
            "message": "Solicitação criada",
            "id": solicitacao_id,
            "resumo": resumo,
            "resumo_admin": resumo_admin,
        }), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/solicitacoes/<int:sol_id>", methods=["GET"])
def get_solicitacao(sol_id):
    try:
        sol = (
            supabase.table("solicitacoes")
            .select("*, solicitacao_itens(*)")
            .eq("id", sol_id)
            .limit(1)
            .execute()
        )
        if not sol.data:
            return jsonify({"error": "Não encontrada"}), 404
        row = sol.data[0]
        if not row.get("resumo_texto"):
            itens = row.get("solicitacao_itens") or []
            row["resumo_texto"] = gerar_resumo(row, itens)
            row["resumo_admin"] = gerar_resumo_admin(row, itens)
        return jsonify(row)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ------------------- API ADMIN -------------------
@app.route("/api/admin/solicitacoes", methods=["GET"])
@api_admin_required
def listar_solicitacoes_admin():
    q = (request.args.get("q") or "").strip().lower()
    try:
        sol_res = (
            supabase.table("solicitacoes")
            .select("*, solicitacao_itens(*)")
            .order("criado_em", desc=True)
            .execute()
        )
        dados = sol_res.data or []
        if q:
            filtrados = []
            for s in dados:
                blob = " ".join([
                    str(s.get("solicitante") or ""),
                    str(s.get("setor_solicitante") or s.get("setor") or ""),
                    str(s.get("equipamento") or ""),
                    str(s.get("as_code") or ""),
                    str(s.get("resumo_admin") or ""),
                    str(s.get("data_solicitacao") or ""),
                ]).lower()
                if q in blob:
                    filtrados.append(s)
                    continue
                for item in s.get("solicitacao_itens") or []:
                    if q in (item.get("funcao") or "").lower():
                        filtrados.append(s)
                        break
            dados = filtrados
        return jsonify(dados)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/solicitacoes/<int:sol_id>", methods=["DELETE"])
@api_admin_required
def apagar_solicitacao(sol_id):
    try:
        # Busca snapshot para auditoria
        sol = (
            supabase.table("solicitacoes")
            .select("*, solicitacao_itens(*)")
            .eq("id", sol_id)
            .limit(1)
            .execute()
        )
        if not sol.data:
            return jsonify({"error": "Solicitação não encontrada"}), 404

        snapshot = sol.data[0]
        # Remove itens e depois a solicitação
        supabase.table("solicitacao_itens").delete().eq("solicitacao_id", sol_id).execute()
        supabase.table("solicitacoes").delete().eq("id", sol_id).execute()

        auditar("remover", "solicitacao", sol_id, {
            "solicitante": snapshot.get("solicitante"),
            "setor": snapshot.get("setor_solicitante") or snapshot.get("setor"),
            "as_code": snapshot.get("as_code"),
            "equipamento": snapshot.get("equipamento"),
            "data_solicitacao": snapshot.get("data_solicitacao"),
            "turno": snapshot.get("turno"),
            "resumo_admin": snapshot.get("resumo_admin"),
            "itens": len(snapshot.get("solicitacao_itens") or []),
        })
        return jsonify({"ok": True, "message": "Solicitação removida"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/exportar", methods=["GET"])
@api_admin_required
def exportar_excel():
    try:
        sol_res = (
            supabase.table("solicitacoes")
            .select("*, solicitacao_itens(*)")
            .order("criado_em", desc=True)
            .execute()
        )
        linhas = []
        for sol in sol_res.data or []:
            solicitante = sol.get("solicitante") or ""
            setor = sol.get("setor_solicitante") or sol.get("setor") or ""
            equipamento = sol.get("equipamento") or ""
            for item in sol.get("solicitacao_itens") or []:
                funcao = item.get("funcao") or ""
                for c in item.get("colaboradores") or []:
                    c = normalizar_colaborador(c)
                    if c.get("a_procura"):
                        linhas.append({
                            "Solicitante": solicitante,
                            "Setor": setor,
                            "Equipamento": equipamento,
                            "Matrícula": c.get("matricula") or "01",
                            "Nome": f"{c.get('descricao') or c.get('nome')} (À procura...)",
                            "Função": funcao,
                        })
                    else:
                        linhas.append({
                            "Solicitante": solicitante,
                            "Setor": setor,
                            "Equipamento": equipamento,
                            "Matrícula": c.get("matricula") or "",
                            "Nome": c.get("nome") or "",
                            "Função": funcao,
                        })
        if not linhas:
            return jsonify({"error": "Nenhum dado para exportar"}), 404

        df = pd.DataFrame(linhas, columns=[
            "Solicitante", "Setor", "Equipamento", "Matrícula", "Nome", "Função"
        ])
        output = BytesIO()
        with pd.ExcelWriter(output, engine="openpyxl") as writer:
            df.to_excel(writer, sheet_name="Solicitações", index=False)
        output.seek(0)
        b64 = base64.b64encode(output.read()).decode()
        return jsonify({
            "excel_base64": b64,
            "filename": "solicitacoes.xlsx",
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/efetivo", methods=["GET"])
def listar_efetivo():
    q = (request.args.get("q") or "").strip().lower()
    try:
        res = (
            supabase.table("funcionarios")
            .select("matricula, nome, funcao")
            .order("nome")
            .execute()
        )
        rows = res.data or []
        if q:
            rows = [
                r for r in rows
                if q in (r.get("matricula") or "").lower()
                or q in (r.get("nome") or "").lower()
                or q in (r.get("funcao") or "").lower()
            ]
        return jsonify(rows)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/efetivo/importar", methods=["POST"])
@api_admin_required
def importar_planilha():
    if "arquivo" not in request.files:
        return jsonify({"error": "Nenhum arquivo enviado."}), 400

    arquivo = request.files["arquivo"]
    if arquivo.filename == "":
        return jsonify({"error": "Nome de arquivo vazio."}), 400

    ext = arquivo.filename.rsplit(".", 1)[-1].lower()
    if ext not in ["xls", "xlsx", "csv"]:
        return jsonify({"error": "Formato não suportado. Use .xls, .xlsx ou .csv"}), 400

    try:
        if ext == "csv":
            df = pd.read_csv(arquivo, dtype=str)
        else:
            df = pd.read_excel(arquivo, header=0, dtype=str)

        colunas_norm = [c.strip().upper() for c in df.columns]
        idx_matricula = idx_nome = idx_funcao = None

        for i, col in enumerate(colunas_norm):
            if "MATRÍCULA" in col or "MATRICULA" in col or "FOLHA" in col or "Nº" in col or "N°" in col:
                idx_matricula = i
            elif col == "NOME":
                idx_nome = i
            elif "FUNÇÃO" in col or "FUNCAO" in col:
                idx_funcao = i

        if idx_matricula is None or idx_nome is None or idx_funcao is None:
            return jsonify({
                "error": "Colunas obrigatórias não encontradas. Esperado: Matrícula, Nome, Função"
            }), 400

        df = df.rename(columns={
            df.columns[idx_matricula]: "matricula",
            df.columns[idx_nome]: "nome",
            df.columns[idx_funcao]: "funcao",
        })
        df = df[["matricula", "nome", "funcao"]]
        df = df.dropna(subset=["matricula"])
        df["matricula"] = df["matricula"].astype(str).str.strip()
        df["nome"] = df["nome"].astype(str).str.strip()
        df["funcao"] = df["funcao"].astype(str).str.strip()
        df = df[df["matricula"] != ""]

        if df.empty:
            return jsonify({"error": "A planilha não contém dados válidos."}), 400

        supabase.table("funcionarios").delete().neq("matricula", "").execute()
        registros = df.to_dict("records")
        for i in range(0, len(registros), 500):
            supabase.table("funcionarios").upsert(registros[i:i + 500]).execute()

        auditar("importar", "efetivo", None, {"total": len(df), "arquivo": arquivo.filename})
        return jsonify({
            "message": f"Importação concluída! {len(df)} colaboradores importados.",
            "total": len(df),
        }), 200
    except Exception as e:
        return jsonify({"error": f"Erro ao processar o arquivo: {str(e)}"}), 500


# ------------------- API CONFIG (Equipamento / Setor / AS) -------------------
@app.route("/api/admin/config/grupos", methods=["GET"])
@api_admin_required
def config_grupos():
    return jsonify([
        {"id": "equipamento", "label": "Equipamento"},
        {"id": "setor_solicitante", "label": "Setor"},
        {"id": "as_code", "label": "AS"},
    ])


@app.route("/api/admin/config/opcoes", methods=["GET"])
@api_admin_required
def config_listar_opcoes():
    grupo = (request.args.get("grupo") or "").strip()
    if grupo and grupo not in GRUPOS_CONFIG:
        return jsonify({"error": "Grupo inválido"}), 400
    try:
        api = _opcoes_para_api()
        if grupo:
            return jsonify(api.get(grupo, []))
        return jsonify(api)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/config/opcoes", methods=["POST"])
@api_admin_required
def config_criar_opcao():
    data = request.get_json() or {}
    grupo = (data.get("grupo") or "").strip()
    valor = (data.get("valor") or "").strip()
    if grupo not in GRUPOS_CONFIG:
        return jsonify({"error": "Grupo inválido. Use: equipamento, setor_solicitante ou as_code"}), 400
    if not valor:
        return jsonify({"error": "Informe o valor da opção"}), 400
    try:
        raw = carregar_opcoes_arquivo()
        lista = list(raw.get(grupo) or [])
        if any(str(v).strip().lower() == valor.lower() for v in lista):
            return jsonify({"error": "Essa opção já existe"}), 400
        lista.append(valor)
        raw[grupo] = lista
        salvar_opcoes_arquivo(raw)
        auditar("criar", "config_opcao", None, {"grupo": grupo, "valor": valor})
        return jsonify({"id": len(lista), "grupo": grupo, "valor": valor, "label": valor}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/config/opcoes/<int:opcao_id>", methods=["PUT"])
@api_admin_required
def config_atualizar_opcao(opcao_id):
    data = request.get_json() or {}
    grupo = (data.get("grupo") or request.args.get("grupo") or "").strip()
    if grupo not in GRUPOS_CONFIG:
        return jsonify({"error": "Informe o grupo"}), 400
    novo = (data.get("valor") or data.get("label") or "").strip()
    if not novo:
        return jsonify({"error": "Valor obrigatório"}), 400
    try:
        raw = carregar_opcoes_arquivo()
        lista = list(raw.get(grupo) or [])
        idx = opcao_id - 1
        if idx < 0 or idx >= len(lista):
            return jsonify({"error": "Opção não encontrada"}), 404
        antigo = lista[idx]
        lista[idx] = novo
        raw[grupo] = lista
        salvar_opcoes_arquivo(raw)
        auditar("editar", "config_opcao", opcao_id, {"grupo": grupo, "de": antigo, "para": novo})
        return jsonify({"id": opcao_id, "grupo": grupo, "valor": novo, "label": novo})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/config/opcoes/<int:opcao_id>", methods=["DELETE"])
@api_admin_required
def config_remover_opcao(opcao_id):
    grupo = (request.args.get("grupo") or "").strip()
    if grupo not in GRUPOS_CONFIG:
        body = request.get_json(silent=True) or {}
        grupo = (body.get("grupo") or "").strip()
    if grupo not in GRUPOS_CONFIG:
        return jsonify({"error": "Informe o grupo"}), 400
    try:
        raw = carregar_opcoes_arquivo()
        lista = list(raw.get(grupo) or [])
        idx = opcao_id - 1
        if idx < 0 or idx >= len(lista):
            return jsonify({"error": "Opção não encontrada"}), 404
        removido = lista.pop(idx)
        raw[grupo] = lista
        salvar_opcoes_arquivo(raw)
        auditar("remover", "config_opcao", opcao_id, {"grupo": grupo, "valor": removido})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/config/opcoes/reordenar", methods=["POST"])
@api_admin_required
def config_reordenar_opcoes():
    data = request.get_json() or {}
    grupo = (data.get("grupo") or "").strip()
    valores = data.get("valores")
    if grupo not in GRUPOS_CONFIG:
        return jsonify({"error": "Grupo inválido"}), 400
    if not isinstance(valores, list):
        return jsonify({"error": "Envie a lista completa de valores"}), 400
    try:
        raw = carregar_opcoes_arquivo()
        raw[grupo] = [str(v).strip() for v in valores if str(v).strip()]
        salvar_opcoes_arquivo(raw)
        return jsonify({"ok": True, "total": len(raw[grupo])})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True)
