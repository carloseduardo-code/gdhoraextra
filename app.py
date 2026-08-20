import os
import json
import re
import time
import unicodedata
from datetime import datetime, timedelta
from functools import wraps
from io import BytesIO
import base64

from flask import (
    Flask, request, jsonify, render_template,
    session, redirect, url_for, flash
)
from supabase import create_client, Client
from dotenv import load_dotenv

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


# ------------------- CACHE SIMPLES EM MEMÓRIA -------------------
# Evita reconsultar o Supabase a cada request para dados que mudam raramente
# (efetivo, opções de formulário, métricas do dashboard). Válido por instância
# do processo: numa cold start da Vercel o cache começa vazio de novo, mas
# entre requests de uma mesma instância "quente" evita round-trips repetidos.
_cache = {}
CACHE_TTL_PADRAO = 45  # segundos


def cache_get(chave):
    item = _cache.get(chave)
    if not item:
        return None
    valor, expira_em = item
    if time.time() > expira_em:
        del _cache[chave]
        return None
    return valor


def cache_set(chave, valor, ttl=CACHE_TTL_PADRAO):
    _cache[chave] = (valor, time.time() + ttl)


def cache_invalidar(*chaves):
    for chave in chaves:
        _cache.pop(chave, None)


def cache_invalidar_prefixo(prefixo):
    for chave in [k for k in _cache if str(k).startswith(prefixo)]:
        _cache.pop(chave, None)


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
    {"id": 0, "chave": "data_solicitacao", "label": "Data da Hora Extra", "tipo": "date", "obrigatorio": True, "ordem": 50, "ativo": True, "lista_grupo": None},
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


def _opcoes_para_api():
    """Opções editáveis (equipamento, setor, AS, turno): Supabase quando configurado,
    arquivo local como fallback (uso em desenvolvimento sem Supabase). Cacheada em
    memória — invalidada explicitamente nas rotas que criam/editam/removem opções."""
    cached = cache_get("opcoes_api")
    if cached is not None:
        return cached

    resultado = _opcoes_para_api_sem_cache()
    cache_set("opcoes_api", resultado)
    return resultado


def _opcoes_para_api_sem_cache():
    if supabase is not None:
        try:
            res = supabase.table("form_opcoes").select("*").eq("ativo", True).order("ordem").execute()
            rows = res.data or []
            if rows:
                resultado = {}
                for r in rows:
                    resultado.setdefault(r["grupo"], []).append({
                        "id": r["id"],
                        "valor": r["valor"],
                        "label": r.get("label") or r["valor"],
                        "ordem": r.get("ordem", 0),
                        "ativo": r.get("ativo", True),
                    })
                _garantir_outros(resultado)
                return resultado
        except Exception:
            pass

    raw = carregar_opcoes_arquivo()
    resultado = {}
    for g, vals in raw.items():
        resultado[g] = [
            {"id": i, "valor": v, "label": v, "ordem": i, "ativo": True}
            for i, v in enumerate(vals, 1)
            if str(v).strip()
        ]
    _garantir_outros(resultado)
    return resultado


def _garantir_outros(resultado):
    """Garante a opção 'Outros' na lista de AS, mesmo que falte na fonte de dados."""
    as_opts = resultado.setdefault("as_code", [])
    if not any(str(o.get("valor", "")).lower() == "outros" for o in as_opts):
        as_opts.append({
            "id": 0,
            "valor": "Outros",
            "label": "Outros",
            "ordem": len(as_opts) + 1,
            "ativo": True,
        })
    return resultado


def carregar_formulario_config():
    """Campos fixos + opções editáveis, priorizando o arquivo local de configuração."""
    opcoes = _opcoes_para_api()

    cache_campos = cache_get("form_campos")
    if cache_campos is not None:
        return {"campos": cache_campos["campos"], "opcoes": opcoes, "fonte": cache_campos["fonte"]}

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

    cache_set("form_campos", {"campos": campos, "fonte": fonte})
    return {
        "campos": campos,
        "opcoes": opcoes,
        "fonte": fonte,
    }


def carregar_funcionarios():
    """Lista completa de funcionários (efetivo), cacheada em memória — evita
    reconsultar o Supabase a cada campo do formulário público (função,
    colaboradores) que hoje bate nessa mesma tabela repetidamente."""
    cached = cache_get("funcionarios")
    if cached is not None:
        return cached
    if supabase is None:
        return []
    res = supabase.table("funcionarios").select("matricula, nome, funcao").order("nome").execute()
    rows = res.data or []
    cache_set("funcionarios", rows)
    return rows


def contar_efetivo():
    try:
        return len(carregar_funcionarios())
    except Exception:
        return 0


# ------------------- ÁREA PÚBLICA -------------------
@app.route("/")
def index():
    return render_template("index.html", efetivo_total=contar_efetivo(), data_hoje=data_extenso_hoje())


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


DIAS_PT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]
MESES_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]
DIAS_EXTENSO_PT = ["Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado", "Domingo"]
MESES_EXTENSO_PT = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]
TURNO_CSS = {"Dia": "t-dia", "Noite": "t-noite", "Extensão de Horário": "t-ext"}


def data_extenso_hoje():
    hoje = datetime.now().date()
    return f"{DIAS_EXTENSO_PT[hoje.weekday()]}, {hoje.day} de {MESES_EXTENSO_PT[hoje.month - 1]} de {hoje.year}"


def turno_css(turno):
    return TURNO_CSS.get(turno, "t-dia")


def _parse_dt(valor):
    if not valor:
        return None
    try:
        s = str(valor).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is not None:
            dt = dt.replace(tzinfo=None)
        return dt
    except Exception:
        return None


# Carga horária por turno. O turno normal (dia ou noite) é a jornada cheia de
# 8 h; a extensão de horário são as 2 h emendadas ao fim do expediente.
HORAS_POR_TURNO = {"Dia": 8, "Noite": 8, "Extensão de Horário": 2}
HORAS_TURNO_PADRAO = 8


def horas_do_turno(turno):
    """Horas de um turno, tolerante a acento e caixa.

    Os turnos sao cadastraveis na configuracao, entao "Extensao de horario"
    e "Extensão de Horário" precisam valer a mesma coisa — errar aqui inflaria
    a conta de horas em silencio.
    """
    bruto = str(turno or "").strip()
    if not bruto:
        return HORAS_TURNO_PADRAO
    normal = unicodedata.normalize("NFD", bruto).encode("ascii", "ignore").decode().lower()
    if "extens" in normal:
        return HORAS_POR_TURNO["Extensão de Horário"]
    for nome, horas in HORAS_POR_TURNO.items():
        alvo = unicodedata.normalize("NFD", nome).encode("ascii", "ignore").decode().lower()
        if normal == alvo:
            return horas
    return HORAS_TURNO_PADRAO


def _pessoas_da_solicitacao(sol):
    """Matrículas distintas na solicitação.

    Uma pessoa marcada em duas funções do mesmo pedido trabalha um turno, não
    dois — contá-la duas vezes dobraria as horas dela.
    """
    pessoas = set()
    for item in sol.get("solicitacao_itens") or []:
        for c in item.get("colaboradores") or []:
            chave = (c.get("matricula") or c.get("nome") or "").strip().lower()
            if chave:
                pessoas.add(chave)
    return pessoas


def _janela_dashboard(periodo, dia):
    """Devolve (inicio, fim, rotulo, eh_dia) em datas, inclusive nas pontas."""
    hoje = datetime.now().date()
    if dia:
        try:
            d = datetime.strptime(dia, "%Y-%m-%d").date()
        except ValueError:
            d = hoje
        rotulo = f"{d.day} de {MESES_EXTENSO_PT[d.month - 1]} de {d.year}"
        return d, d, rotulo, True
    if periodo == "tudo":
        return None, None, "Todo o período", False
    dias = 30 if periodo == "30" else 7
    return hoje - timedelta(days=dias - 1), hoje, f"Últimos {dias} dias", False


def calcular_metricas_dashboard(periodo="7", dia=""):
    chave = f"dashboard_metricas:{periodo}:{dia}"
    cached = cache_get(chave)
    if cached is not None:
        return cached
    resultado = _calcular_metricas_dashboard_sem_cache(periodo, dia)
    cache_set(chave, resultado, ttl=30)
    return resultado


def _calcular_metricas_dashboard_sem_cache(periodo="7", dia=""):
    inicio, fim, rotulo, eh_dia = _janela_dashboard(periodo, dia)
    filtro = {
        "periodo": "dia" if eh_dia else (periodo or "7"),
        "dia": dia or "",
        "rotulo": rotulo,
        "eh_dia": eh_dia,
    }
    vazio = {
        "filtro": filtro,
        "metrics": [
            {"label": "Solicitações", "value": 0, "delta": "", "delta_dir": "", "hint": rotulo.lower()},
            {"label": "Colaboradores", "value": 0, "delta": "", "delta_dir": "", "hint": "pessoas distintas"},
            {"label": "Horas extras", "value": "0 h", "delta": "", "delta_dir": "", "hint": "turno × pessoas"},
            {"label": "Equipamentos", "value": 0, "delta": "", "delta_dir": "", "hint": "vinculados no período"},
        ],
        "horas": {"total": 0, "por_turno": [], "media": 0},
        "dias": [],
        "top_funcoes": [],
        "turno_split": [],
        "recentes": [],
        "total_solicitacoes": 0,
    }
    if supabase is None:
        return vazio

    try:
        res = (
            supabase.table("solicitacoes")
            .select("*, solicitacao_itens(*)")
            .order("data_solicitacao", desc=True)
            .execute()
        )
        dados = res.data or []
    except Exception:
        return vazio

    def data_da(sol):
        """A data em que a hora extra acontece — não a de digitação."""
        bruta = sol.get("data_solicitacao")
        if bruta:
            try:
                return datetime.strptime(str(bruta)[:10], "%Y-%m-%d").date()
            except ValueError:
                pass
        dt = _parse_dt(sol.get("criado_em"))
        return dt.date() if dt else None

    def na_janela(d, ini, f):
        if d is None:
            return False
        if ini and d < ini:
            return False
        if f and d > f:
            return False
        return True

    # Janela anterior de mesmo tamanho, para as variações.
    if inicio and fim:
        tamanho = (fim - inicio).days + 1
        ant_fim = inicio - timedelta(days=1)
        ant_inicio = ant_fim - timedelta(days=tamanho - 1)
    else:
        ant_inicio = ant_fim = None

    no_periodo, no_anterior = [], []
    for sol in dados:
        d = data_da(sol)
        if na_janela(d, inicio, fim):
            no_periodo.append((d, sol))
        elif ant_inicio and na_janela(d, ant_inicio, ant_fim):
            no_anterior.append((d, sol))

    def agrega(lista):
        pessoas, horas, equipamentos = set(), 0, 0
        for _, sol in lista:
            do_pedido = _pessoas_da_solicitacao(sol)
            pessoas |= do_pedido
            horas += horas_do_turno(sol.get("turno") or "Dia") * len(do_pedido)
            if (sol.get("equipamento") or "").strip():
                equipamentos += 1
        return len(pessoas), horas, equipamentos

    pessoas_qtd, horas_total, equip_qtd = agrega(no_periodo)
    pessoas_ant, horas_ant, _ = agrega(no_anterior)

    # ---- horas por turno ----
    turno_totais, turno_pessoas, turno_horas = {}, {}, {}
    funcao_totais = {}
    contagem_dias = {}
    for d, sol in no_periodo:
        turno = sol.get("turno") or "Dia"
        do_pedido = _pessoas_da_solicitacao(sol)
        turno_totais[turno] = turno_totais.get(turno, 0) + 1
        turno_pessoas[turno] = turno_pessoas.get(turno, 0) + len(do_pedido)
        turno_horas[turno] = turno_horas.get(turno, 0) + horas_do_turno(turno) * len(do_pedido)
        if d:
            contagem_dias[d.isoformat()] = contagem_dias.get(d.isoformat(), 0) + 1

        equip_nome = (sol.get("equipamento") or "").strip()
        for item in sol.get("solicitacao_itens") or []:
            funcao = (item.get("funcao") or "").strip()
            if not funcao or (equip_nome and funcao.upper() == equip_nome.upper()):
                continue
            qtd = len(item.get("colaboradores") or []) or int(item.get("quantidade") or 0)
            funcao_totais[funcao] = funcao_totais.get(funcao, 0) + qtd

    max_horas = max(turno_horas.values()) if turno_horas else 0
    horas_por_turno = [
        {
            "label": t,
            "css": turno_css(t),
            "unit": horas_do_turno(t),
            "pessoas": turno_pessoas.get(t, 0),
            "horas": turno_horas.get(t, 0),
            "pct": round(turno_horas.get(t, 0) / max_horas * 100) if max_horas else 0,
        }
        for t in ("Dia", "Noite", "Extensão de Horário")
        if turno_totais.get(t, 0) > 0
    ]

    # ---- barras por dia ----
    if eh_dia:
        janela_fim = fim
        n_barras = 7
    elif inicio and fim:
        janela_fim = fim
        n_barras = min((fim - inicio).days + 1, 31)
    else:
        janela_fim = datetime.now().date()
        n_barras = 30

    valores = []
    for i in range(n_barras - 1, -1, -1):
        d = janela_fim - timedelta(days=i)
        valores.append((d, contagem_dias.get(d.isoformat(), 0)))
    max_dia = max((v for _, v in valores), default=0) or 1
    passo_rotulo = 1 if n_barras <= 10 else (3 if n_barras <= 16 else 5)
    dias_barras = [
        {
            "label": DIAS_PT[d.weekday()] if (idx % passo_rotulo == 0 or idx == n_barras - 1) else "",
            "titulo": d.strftime("%d/%m"),
            "value": v,
            "altura": round(20 + (v / max_dia) * 96),
            "atual": (eh_dia and d == fim) or (not eh_dia and d == datetime.now().date()),
        }
        for idx, (d, v) in enumerate(valores)
    ]

    top_lista = sorted(funcao_totais.items(), key=lambda kv: kv[1], reverse=True)[:5]
    max_funcao = (top_lista[0][1] if top_lista else 0) or 1
    top_funcoes = [
        {"label": k, "value": v, "pct": round(v / max_funcao * 100), "top": i == 0}
        for i, (k, v) in enumerate(top_lista)
    ]

    turno_total = sum(turno_totais.values()) or 1
    turno_split = [
        {"label": t, "value": turno_totais.get(t, 0), "pct": round(turno_totais.get(t, 0) / turno_total * 100), "css": turno_css(t)}
        for t in ("Dia", "Noite", "Extensão de Horário")
        if turno_totais.get(t, 0) > 0
    ]

    def _delta_abs(atual, anterior):
        if ant_inicio is None:
            return "", ""
        diff = atual - anterior
        if diff == 0:
            return "", ""
        return (f"+{diff}" if diff > 0 else str(diff)), ("up" if diff > 0 else "down")

    sol_delta, sol_dir = _delta_abs(len(no_periodo), len(no_anterior))
    horas_delta, horas_dir = _delta_abs(horas_total, horas_ant)
    if horas_delta:
        horas_delta += " h"
    pess_delta, pess_dir = _delta_abs(pessoas_qtd, pessoas_ant)

    if eh_dia:
        dica_periodo = "no dia"
        dica_anterior = f"vs. {len(no_anterior)} no dia anterior"
    elif ant_inicio:
        dica_anterior = f"vs. {len(no_anterior)} no período anterior"
        dica_periodo = rotulo.lower()
    else:
        dica_anterior = "todas as solicitações"
        dica_periodo = rotulo.lower()

    metrics = [
        {"label": "Solicitações", "value": len(no_periodo), "delta": sol_delta, "delta_dir": sol_dir, "hint": dica_anterior},
        {"label": "Colaboradores", "value": pessoas_qtd, "delta": pess_delta, "delta_dir": pess_dir, "hint": "pessoas distintas"},
        {"label": "Horas extras", "value": f"{horas_total} h", "delta": horas_delta, "delta_dir": horas_dir, "hint": "turno × pessoas"},
        {"label": "Equipamentos", "value": equip_qtd, "delta": "", "delta_dir": "", "hint": f"vinculados {dica_periodo}"},
    ]

    recentes = []
    for d, sol in no_periodo[:5]:
        pessoas_pedido = len(_pessoas_da_solicitacao(sol))
        turno = sol.get("turno") or "Dia"
        recentes.append({
            "dia": f"{d.day:02d}" if d else "—",
            "mes": MESES_PT[d.month - 1] if d else "",
            "titulo": sol.get("as_code") or sol.get("equipamento") or "—",
            "solicitante": sol.get("solicitante") or "—",
            "setor": sol.get("setor_solicitante") or sol.get("setor") or "—",
            "qtd": pessoas_pedido,
            "horas": horas_do_turno(turno) * pessoas_pedido,
            "turno": turno,
            "turno_css": turno_css(turno),
        })

    return {
        "filtro": filtro,
        "metrics": metrics,
        "horas": {
            "total": horas_total,
            "por_turno": horas_por_turno,
            "media": (f"{horas_total / pessoas_qtd:.1f}".replace(".", ",")) if pessoas_qtd else "0",
        },
        "dias": dias_barras,
        "top_funcoes": top_funcoes,
        "turno_split": turno_split,
        "recentes": recentes,
        "total_solicitacoes": len(no_periodo),
    }


@app.route("/admin")
@admin_required
def admin_home():
    periodo = (request.args.get("periodo") or "7").strip()
    dia = (request.args.get("dia") or "").strip()
    return render_template(
        "admin/index.html",
        user=usuario_logado(),
        dash=calcular_metricas_dashboard(periodo, dia),
    )


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


AUDIT_ICON_META = {
    "login": {"path": "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3", "bg": "#F2F4F7", "fg": "#475467"},
    "logout": {"path": "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9", "bg": "#F2F4F7", "fg": "#475467"},
    "remover": {"path": "M5 7h14M10 11v6M14 11v6M6 7l1 12h10L18 7M9 7V4h6v3", "bg": "#FEF3F2", "fg": "#B42318"},
    "criar": {"path": "M12 5v14M5 12h14", "bg": "#EAF3EE", "fg": "#165F3F"},
    "editar": {"path": "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z", "bg": "#EAF3EE", "fg": "#165F3F"},
    "aprovar": {"path": "M20 6 9 17l-5-5", "bg": "#EAF3EE", "fg": "#165F3F"},
    "cadastro": {"path": "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M11 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M20 8v6M23 11h-6", "bg": "#EAF3EE", "fg": "#165F3F"},
    "importar": {"path": "M12 15V3M7 8l5-5 5 5M4 21h16", "bg": "#FFFBF2", "fg": "#B45309"},
}
DEFAULT_AUDIT_ICON = {"path": "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z", "bg": "#F2F4F7", "fg": "#475467"}


def _detalhes_dict(raw):
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except Exception:
        return {}


def frase_auditoria(log):
    acao = log.get("acao") or ""
    entidade = log.get("entidade") or ""
    eid = log.get("entidade_id")
    det = _detalhes_dict(log.get("detalhes"))

    if entidade == "usuario" and acao == "login":
        return "entrou na área administrativa"
    if entidade == "usuario" and acao == "logout":
        return "saiu da área administrativa"
    if entidade == "solicitacao" and acao == "criar":
        return f"criou a solicitação #{eid}" if eid else "criou uma solicitação"
    if entidade == "solicitacao" and acao == "remover":
        return f"apagou a solicitação #{eid}" if eid else "apagou uma solicitação"
    if entidade == "solicitacao" and acao == "editar":
        return f"editou a solicitação #{eid}" if eid else "editou uma solicitação"
    if entidade == "efetivo" and acao == "importar":
        total = det.get("total")
        return f"importou planilha com {total} colaboradores" if total else "importou uma planilha de efetivo"
    if entidade == "config_opcao":
        grupo = det.get("grupo") or ""
        if acao == "criar":
            return f"adicionou \"{det.get('valor', '')}\" em {grupo}".strip()
        if acao == "editar":
            return f"editou uma opção em {grupo}".strip()
        if acao == "remover":
            return f"removeu \"{det.get('valor', '')}\" de {grupo}".strip()
    if entidade == "usuario" and acao == "cadastro":
        return f"cadastrou o usuário {det.get('usuario', '')}".strip()
    if entidade == "usuario" and acao == "aprovar":
        return "aprovou um novo acesso"
    return f"{acao} · {entidade}" + (f" #{eid}" if eid else "")


def formatar_data_hora_br(valor):
    dt = _parse_dt(valor)
    if not dt:
        return str(valor or "")
    return dt.strftime("%d/%m %H:%M")


def preparar_logs_auditoria(logs):
    preparados = []
    for log in logs:
        det = _detalhes_dict(log.get("detalhes"))
        det_fmt = json.dumps(det, indent=2, ensure_ascii=False) if det else ""
        meta = AUDIT_ICON_META.get(log.get("acao"), DEFAULT_AUDIT_ICON)
        preparados.append({
            "usuario": log.get("usuario_nome") or "desconhecido",
            "frase": frase_auditoria(log),
            "quando": formatar_data_hora_br(log.get("criado_em")),
            "detalhes": det_fmt,
            "has_det": bool(det_fmt),
            "icon": meta["path"],
            "icon_bg": meta["bg"],
            "icon_fg": meta["fg"],
            "busca": " ".join([
                str(log.get("usuario_nome") or ""),
                str(log.get("acao") or ""),
                str(log.get("entidade") or ""),
                str(log.get("entidade_id") or ""),
                det_fmt,
            ]).lower(),
        })
    return preparados


@app.route("/admin/auditoria")
@admin_required
def admin_auditoria():
    return render_template(
        "admin/auditoria.html",
        user=usuario_logado(),
        logs=preparar_logs_auditoria(auth_db.listar_auditoria(limit=200)),
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
        funcoes = sorted({row["funcao"] for row in carregar_funcionarios() if row.get("funcao")})
        return jsonify(funcoes)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/colaboradores", methods=["GET"])
def get_colaboradores():
    funcao = request.args.get("funcao")
    q = (request.args.get("q") or "").strip().lower()
    try:
        rows = carregar_funcionarios()
        if funcao:
            rows = [r for r in rows if r.get("funcao") == funcao]
        rows = sorted(rows, key=lambda r: r.get("nome") or "")
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

    if not solicitante:
        return jsonify({"error": "Solicitante é obrigatório"}), 400

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

        sol_res = supabase.table("solicitacoes").insert({**sol_payload, **extras}).execute()

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
        cache_invalidar_prefixo("dashboard_metricas")

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
    data_filtro = (request.args.get("data") or "").strip()
    try:
        sol_res = (
            supabase.table("solicitacoes")
            .select("*, solicitacao_itens(*)")
            .order("criado_em", desc=True)
            .execute()
        )
        dados = sol_res.data or []
        if data_filtro:
            dados = [s for s in dados if str(s.get("data_solicitacao") or "") == data_filtro]
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
        cache_invalidar_prefixo("dashboard_metricas")
        return jsonify({"ok": True, "message": "Solicitação removida"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/solicitacoes/<int:sol_id>", methods=["PUT"])
@api_admin_required
def editar_solicitacao_admin(sol_id):
    try:
        existente = (
            supabase.table("solicitacoes")
            .select("*, solicitacao_itens(*)")
            .eq("id", sol_id)
            .limit(1)
            .execute()
        )
        if not existente.data:
            return jsonify({"error": "Solicitação não encontrada"}), 404
        antes = existente.data[0]

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

        if not solicitante:
            return jsonify({"error": "Solicitante é obrigatório"}), 400
        if not data_solicitacao:
            return jsonify({"error": "Data da solicitação é obrigatória"}), 400

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
            "solicitante": solicitante or None,
            "setor_solicitante": setor_solicitante or None,
            "equipamento": equipamento or None,
            "observacao": observacao or None,
            "resumo_texto": resumo,
            "resumo_admin": resumo_admin,
        }
        supabase.table("solicitacoes").update(sol_payload).eq("id", sol_id).execute()

        supabase.table("solicitacao_itens").delete().eq("solicitacao_id", sol_id).execute()
        for item in itens_norm:
            supabase.table("solicitacao_itens").insert({
                "solicitacao_id": sol_id,
                "funcao": item["funcao"],
                "quantidade": item["quantidade"],
                "colaboradores": item["colaboradores"],
            }).execute()

        auditar("editar", "solicitacao", sol_id, {
            "antes": {
                "solicitante": antes.get("solicitante"),
                "setor": antes.get("setor_solicitante") or antes.get("setor"),
                "as_code": antes.get("as_code"),
                "data_solicitacao": antes.get("data_solicitacao"),
                "turno": antes.get("turno"),
            },
            "depois": {
                "solicitante": solicitante or None,
                "setor": setor_solicitante or None,
                "as_code": as_code or None,
                "data_solicitacao": data_solicitacao,
                "turno": turno,
            },
            "itens": len(itens_norm),
        })
        cache_invalidar_prefixo("dashboard_metricas")

        return jsonify({
            "message": "Solicitação atualizada",
            "id": sol_id,
            "resumo": resumo,
            "resumo_admin": resumo_admin,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/exportar", methods=["GET"])
@api_admin_required
def exportar_excel():
    import pandas as pd
    try:
        sol_res = (
            supabase.table("solicitacoes")
            .select("*, solicitacao_itens(*)")
            .order("criado_em", desc=True)
            .execute()
        )
        linhas = []
        for sol in sol_res.data or []:
            data_he = formatar_data_br(sol.get("data_solicitacao"))
            setor = sol.get("setor_solicitante") or sol.get("setor") or ""
            quem_solicitou = sol.get("solicitante") or ""
            as_code = sol.get("as_code") or ""

            for item in sol.get("solicitacao_itens") or []:
                tipo = item.get("tipo") or "funcao"
                equipamento_nome = item.get("equipamento") or (item.get("funcao") if tipo == "equipamento" else "") or ""
                colaboradores = item.get("colaboradores") or []

                if not colaboradores:
                    if tipo == "equipamento":
                        linhas.append({
                            "Data da Hora Extra": data_he,
                            "Solicitante": setor,
                            "Quem solicitou": quem_solicitou,
                            "AS da solicitação": as_code,
                            "Colaborador": "",
                            "Matrícula": "",
                            "Equipamento": equipamento_nome,
                        })
                    continue

                for c in colaboradores:
                    c = normalizar_colaborador(c)
                    if c.get("a_procura"):
                        nome = f"{c.get('descricao') or c.get('nome')} (À procura...)"
                        matricula = c.get("matricula") or "01"
                    else:
                        nome = c.get("nome") or ""
                        matricula = c.get("matricula") or ""
                    linhas.append({
                        "Data da Hora Extra": data_he,
                        "Solicitante": setor,
                        "Quem solicitou": quem_solicitou,
                        "AS da solicitação": as_code,
                        "Colaborador": nome,
                        "Matrícula": matricula,
                        "Equipamento": equipamento_nome if tipo == "equipamento" else "",
                    })

        if not linhas:
            return jsonify({"error": "Nenhum dado para exportar"}), 404

        df = pd.DataFrame(linhas, columns=[
            "Data da Hora Extra", "Solicitante", "Quem solicitou",
            "AS da solicitação", "Colaborador", "Matrícula", "Equipamento",
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
        rows = carregar_funcionarios()
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
    import pandas as pd
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

        cache_invalidar("funcionarios")
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
        if supabase is not None:
            existente = (
                supabase.table("form_opcoes")
                .select("id").eq("grupo", grupo).ilike("valor", valor)
                .execute()
            )
            if existente.data:
                return jsonify({"error": "Essa opção já existe"}), 400
            maior = (
                supabase.table("form_opcoes")
                .select("ordem").eq("grupo", grupo).order("ordem", desc=True).limit(1)
                .execute()
            )
            proxima_ordem = ((maior.data[0]["ordem"] if maior.data else 0) or 0) + 1
            res = supabase.table("form_opcoes").insert({
                "grupo": grupo, "valor": valor, "label": valor, "ordem": proxima_ordem,
            }).execute()
            row = res.data[0]
            auditar("criar", "config_opcao", row["id"], {"grupo": grupo, "valor": valor})
            cache_invalidar("opcoes_api")
            return jsonify({"id": row["id"], "grupo": grupo, "valor": valor, "label": valor}), 201

        raw = carregar_opcoes_arquivo()
        lista = list(raw.get(grupo) or [])
        if any(str(v).strip().lower() == valor.lower() for v in lista):
            return jsonify({"error": "Essa opção já existe"}), 400
        lista.append(valor)
        raw[grupo] = lista
        salvar_opcoes_arquivo(raw)
        auditar("criar", "config_opcao", None, {"grupo": grupo, "valor": valor})
        cache_invalidar("opcoes_api")
        return jsonify({"id": len(lista), "grupo": grupo, "valor": valor, "label": valor}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/config/opcoes/<int:opcao_id>", methods=["PUT"])
@api_admin_required
def config_atualizar_opcao(opcao_id):
    data = request.get_json() or {}
    grupo = (data.get("grupo") or request.args.get("grupo") or "").strip()
    novo = (data.get("valor") or data.get("label") or "").strip()
    if not novo:
        return jsonify({"error": "Valor obrigatório"}), 400
    try:
        if supabase is not None:
            existente = (
                supabase.table("form_opcoes").select("id, grupo, valor").eq("id", opcao_id).limit(1).execute()
            )
            if not existente.data:
                return jsonify({"error": "Opção não encontrada"}), 404
            antigo = existente.data[0]
            grupo_final = grupo or antigo["grupo"]
            supabase.table("form_opcoes").update({"valor": novo, "label": novo}).eq("id", opcao_id).execute()
            auditar("editar", "config_opcao", opcao_id, {"grupo": grupo_final, "de": antigo["valor"], "para": novo})
            cache_invalidar("opcoes_api")
            return jsonify({"id": opcao_id, "grupo": grupo_final, "valor": novo, "label": novo})

        if grupo not in GRUPOS_CONFIG:
            return jsonify({"error": "Informe o grupo"}), 400
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
        cache_invalidar("opcoes_api")
        return jsonify({"id": opcao_id, "grupo": grupo, "valor": novo, "label": novo})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/config/opcoes/<int:opcao_id>", methods=["DELETE"])
@api_admin_required
def config_remover_opcao(opcao_id):
    grupo = (request.args.get("grupo") or "").strip()
    if not grupo:
        body = request.get_json(silent=True) or {}
        grupo = (body.get("grupo") or "").strip()
    try:
        if supabase is not None:
            existente = (
                supabase.table("form_opcoes").select("id, grupo, valor").eq("id", opcao_id).limit(1).execute()
            )
            if not existente.data:
                return jsonify({"error": "Opção não encontrada"}), 404
            antigo = existente.data[0]
            supabase.table("form_opcoes").delete().eq("id", opcao_id).execute()
            auditar("remover", "config_opcao", opcao_id, {"grupo": antigo["grupo"], "valor": antigo["valor"]})
            cache_invalidar("opcoes_api")
            return jsonify({"ok": True})

        if grupo not in GRUPOS_CONFIG:
            return jsonify({"error": "Informe o grupo"}), 400
        raw = carregar_opcoes_arquivo()
        lista = list(raw.get(grupo) or [])
        idx = opcao_id - 1
        if idx < 0 or idx >= len(lista):
            return jsonify({"error": "Opção não encontrada"}), 404
        removido = lista.pop(idx)
        raw[grupo] = lista
        salvar_opcoes_arquivo(raw)
        auditar("remover", "config_opcao", opcao_id, {"grupo": grupo, "valor": removido})
        cache_invalidar("opcoes_api")
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
        if supabase is not None:
            for i, v in enumerate(valores, 1):
                supabase.table("form_opcoes").update({"ordem": i}).eq("grupo", grupo).eq("valor", str(v).strip()).execute()
            cache_invalidar("opcoes_api")
            return jsonify({"ok": True, "total": len(valores)})

        raw = carregar_opcoes_arquivo()
        raw[grupo] = [str(v).strip() for v in valores if str(v).strip()]
        salvar_opcoes_arquivo(raw)
        cache_invalidar("opcoes_api")
        return jsonify({"ok": True, "total": len(raw[grupo])})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True)
