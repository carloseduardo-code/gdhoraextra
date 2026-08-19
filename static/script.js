let formConfig = { campos: [], opcoes: {} };
let funcoes = [];
let efetivo = [];
let previaDebounce = null;

const CAMPOS_SKIP = new Set(['equipamento', 'funcoes']); // equipamento vai para seção própria

const TOTAL_ETAPAS = 4;
const STEP_NAMES = ['Dados', 'Funções', 'Equipamentos', 'Revisão'];
let etapaAtual = 1;
let maiorEtapaAlcancada = 1;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await Promise.all([carregarFormulario(), carregarFuncoes(), carregarEfetivo()]);
        renderCampos();
        if (!document.querySelector('.bloco-funcao')) adicionarBloco();
        atualizarResumoPrevia();
    } catch (err) {
        console.error(err);
        mostrarErro('Não foi possível carregar o formulário.');
    }

    document.getElementById('add-funcao').addEventListener('click', () => {
        adicionarBloco();
        atualizarResumoPrevia();
    });
    document.getElementById('add-equipamento').addEventListener('click', () => {
        adicionarBlocoEquipamento();
        atualizarEquipamentosVazio();
        atualizarResumoPrevia();
    });
    document.getElementById('solicitacao-form').addEventListener('submit', enviarSolicitacao);
    document.getElementById('solicitacao-form').addEventListener('input', agendarResumoPrevia);
    document.getElementById('solicitacao-form').addEventListener('change', agendarResumoPrevia);

    initWizard();
    initSheet();
    atualizarEquipamentosVazio();
});

/* ---------- Wizard (etapas) ---------- */
function initWizard() {
    document.getElementById('btn-proximo').addEventListener('click', () => {
        if (etapaAtual === 1 && !validarEtapa1()) return;
        if (etapaAtual === 3 && !validarEtapa3()) return;
        mostrarEtapa(Math.min(etapaAtual + 1, TOTAL_ETAPAS));
    });

    document.getElementById('btn-voltar').addEventListener('click', () => {
        mostrarEtapa(Math.max(etapaAtual - 1, 1));
    });

    document.querySelectorAll('.wizard-step').forEach(pill => {
        pill.addEventListener('click', () => {
            const alvo = Number(pill.dataset.stepIndicator);
            if (alvo <= maiorEtapaAlcancada) mostrarEtapa(alvo);
        });
    });

    mostrarEtapa(1, { semScroll: true });
}

function mostrarEtapa(n, opts) {
    mostrarErro('');
    etapaAtual = n;
    if (n > maiorEtapaAlcancada) maiorEtapaAlcancada = n;

    document.querySelectorAll('[data-step]').forEach(el => {
        el.hidden = Number(el.dataset.step) !== n;
    });

    document.querySelectorAll('.wizard-step').forEach(pill => {
        const s = Number(pill.dataset.stepIndicator);
        pill.classList.toggle('active', s === n);
        pill.classList.toggle('done', s !== n && s <= maiorEtapaAlcancada);
    });

    document.getElementById('btn-voltar').hidden = n === 1;
    document.getElementById('btn-proximo').hidden = n === TOTAL_ETAPAS;
    document.getElementById('btn-enviar').hidden = n !== TOTAL_ETAPAS;

    const brandStep = document.getElementById('wizard-brand-step');
    if (brandStep) brandStep.textContent = `Etapa ${n} de ${TOTAL_ETAPAS} · ${STEP_NAMES[n - 1]}`;
    const progressFill = document.getElementById('wizard-progress-fill');
    if (progressFill) progressFill.style.width = `${(n / TOTAL_ETAPAS) * 100}%`;
    atualizarNavHint();

    if (n === TOTAL_ETAPAS) atualizarResumoPrevia();

    if (!opts?.semScroll) {
        const form = document.getElementById('solicitacao-form');
        if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

/* Depois de carregar, o rótulo vira informação útil em vez de sumir. */
function atualizarNavHint() {
    const navHint = document.getElementById('wizard-nav-hint');
    if (!navHint) return;
    if (etapaAtual !== TOTAL_ETAPAS) {
        navHint.textContent = `Etapa ${etapaAtual} de ${TOTAL_ETAPAS}`;
        return;
    }
    const itens = coletarItensFuncoes();
    const pessoas = totalPessoasMarcadas();
    navHint.textContent = pessoas
        ? `${pessoas} ${pessoas === 1 ? 'colaborador' : 'colaboradores'} · ${itens.length} ${itens.length === 1 ? 'função' : 'funções'}`
        : 'Revise antes de enviar';
}

/* A lista de uma função pode estar dentro da ficha ou dentro da seleção em
   tela cheia; as duas contam como a mesma lista. */
function listaDoBloco(bloco) {
    const dentro = bloco.querySelector('.colaboradores-container');
    if (dentro) return dentro;
    const naFolha = document.querySelector('#sheet-colaboradores .colaboradores-container');
    return naFolha && naFolha.blocoDono === bloco ? naFolha : null;
}

/* Uma pessoa marcada em duas funções conta uma vez só. */
function totalPessoasMarcadas() {
    const set = new Set();
    document.querySelectorAll('#blocos-container .bloco-funcao').forEach(bloco => {
        listaDoBloco(bloco)?.querySelectorAll('input[type="checkbox"]:checked')
            .forEach(cb => set.add(cb.dataset.matricula));
    });
    return set.size;
}

function irParaPrimeiroErro() {
    const el = document.querySelector('.campo-invalido, .is-invalid');
    if (!el) return;
    const stepEl = el.closest('[data-step]');
    const step = stepEl ? Number(stepEl.dataset.step) : null;
    if (step && step !== etapaAtual) {
        const msgAtual = document.getElementById('form-erro')?.textContent || '';
        mostrarEtapa(step);
        mostrarErro(msgAtual);
    }
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
}

function validarEtapa1() {
    const campos = coletarCamposForm();
    const { ok, msg } = validarCamposObrigatorios(campos);
    if (!ok) {
        mostrarErro(msg);
        document.querySelector('.campo-invalido')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return ok;
}

function validarEtapa3() {
    mostrarErro('');
    let ok = true;
    let msg = '';
    document.querySelectorAll('.bloco-equipamento').forEach(bloco => {
        const eq = bloco.querySelector('.equipamento-select');
        const op = bloco.querySelector('.operador-valor');
        const temEq = !!eq?.value;
        const temOp = !!(op?.value);
        if (temOp && !temEq) {
            marcarInvalido(eq, true);
            ok = false;
            msg = msg || 'Selecione o equipamento correspondente ao operador informado.';
        } else {
            marcarInvalido(eq, false);
        }
    });
    if (!ok) mostrarErro(msg);
    return ok;
}

async function carregarFormulario() {
    const res = await fetch('/api/formulario');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao carregar formulário');
    formConfig = data;
    // Garante opção Outros em AS
    const asOpts = formConfig.opcoes.as_code || [];
    if (!asOpts.some(o => (o.valor || '').toLowerCase() === 'outros')) {
        asOpts.push({ id: 'outros', valor: 'Outros', label: 'Outros' });
        formConfig.opcoes.as_code = asOpts;
    }
}

async function carregarFuncoes() {
    try {
        const res = await fetch('/api/funcoes');
        const data = await res.json();
        funcoes = Array.isArray(data) ? data : [];
    } catch {
        funcoes = [];
    }
}

async function carregarEfetivo() {
    try {
        const res = await fetch('/api/efetivo');
        const data = await res.json();
        efetivo = Array.isArray(data) ? data : [];
    } catch {
        efetivo = [];
    }
}

function mostrarErro(msg) {
    const el = document.getElementById('form-erro');
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || '';
}

/* O erro vive no campo que falhou, com a saída junto — um erro no topo
   obriga o solicitante a procurar o que deu errado. */
function marcarInvalido(el, invalido, mensagem) {
    if (!el) return;
    const group = el.closest('.form-group') || el.closest('.combobox')?.parentElement;
    if (group) {
        group.classList.toggle('campo-invalido', !!invalido);
        let msgEl = group.querySelector(':scope > .campo-erro-msg');
        if (invalido && mensagem) {
            if (!msgEl) {
                msgEl = document.createElement('p');
                msgEl.className = 'campo-erro-msg';
                group.appendChild(msgEl);
            }
            msgEl.textContent = mensagem;
        } else if (msgEl) {
            msgEl.remove();
        }
    }
    el.classList.toggle('is-invalid', !!invalido);
}

/* Mensagem por campo: diz o que fazer, não só que faltou. */
const MSG_CAMPO = {
    as_code: 'Escolha a AS que vai receber as horas. Se não estiver na lista, use “Outros”.',
    as_code_outros: 'Informe o código da AS que vai receber as horas.',
    data_solicitacao: 'Escolha a data do serviço.',
    solicitante: 'Digite a matrícula ou o nome e escolha na lista.',
    setor_solicitante: 'Escolha o setor que está pedindo a hora extra.',
};

function msgDoCampo(campo) {
    return MSG_CAMPO[campo.chave] || `Preencha ${String(campo.label || '').toLowerCase()}.`;
}

function setupSearchSelect(selectEl) {
    if (!selectEl || selectEl.dataset.searchableReady === 'true') return;

    const wrapper = document.createElement('div');
    wrapper.className = 'searchable-select';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'searchable-input';
    input.autocomplete = 'off';
    input.placeholder = 'Buscar ou selecionar...';
    input.setAttribute('aria-label', 'Filtrar opções');
    if (selectEl.id) input.id = `${selectEl.id}-busca`;

    const listBox = document.createElement('div');
    listBox.className = 'searchable-list';
    listBox.hidden = true;

    selectEl.parentNode.insertBefore(wrapper, selectEl);
    wrapper.appendChild(input);
    wrapper.appendChild(listBox);
    wrapper.appendChild(selectEl);

    selectEl.dataset.searchableReady = 'true';
    selectEl.style.display = 'none';
    selectEl.setAttribute('aria-hidden', 'true');
    selectEl.tabIndex = -1;

    const renderList = () => {
        const q = (input.value || '').trim().toLowerCase();
        const options = Array.from(selectEl.options || []).filter(opt => (opt.value || '').trim() !== '');
        const filtradas = !q
            ? options
            : options.filter(opt => (opt.textContent || '').toLowerCase().includes(q) || (opt.value || '').toLowerCase().includes(q));

        if (!filtradas.length) {
            listBox.innerHTML = '<div class="searchable-item-empty">Nenhuma opção encontrada</div>';
            listBox.hidden = false;
            return;
        }

        listBox.innerHTML = filtradas.map(opt => `
            <button type="button" class="searchable-item" data-value="${escAttr(opt.value || '')}">${escapar(opt.textContent || '')}</button>
        `).join('');
        listBox.hidden = false;

        listBox.querySelectorAll('.searchable-item').forEach(btn => {
            btn.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                selectEl.value = btn.dataset.value;
                input.value = btn.textContent.trim();
                listBox.hidden = true;
                selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            });
        });
    };

    const syncSelection = () => {
        const selected = Array.from(selectEl.options || []).find(opt => opt.value === selectEl.value);
        if (selected) {
            input.value = selected.textContent.trim();
        }
    };

    input.addEventListener('focus', renderList);
    input.addEventListener('input', renderList);
    input.addEventListener('blur', () => setTimeout(() => { listBox.hidden = true; }, 150));
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
            listBox.hidden = true;
        }
    });
    selectEl.addEventListener('change', syncSelection);

    syncSelection();
}

function refreshSearchSelect(selectEl) {
    if (!selectEl || selectEl.dataset.searchableReady !== 'true') return;
    const wrapper = selectEl.closest('.searchable-select');
    if (!wrapper) return;
    const input = wrapper.querySelector('.searchable-input');
    if (input) {
        const selected = Array.from(selectEl.options || []).find(opt => opt.value === selectEl.value);
        input.value = selected ? selected.textContent.trim() : '';
    }
}

/* ---------- Campos dinâmicos (dados gerais) ---------- */
function renderCampos() {
    const container = document.getElementById('campos-dinamicos');
    container.innerHTML = '';
    container.className = 'campos-grid';

    const campos = (formConfig.campos || [])
        .filter(c => c.ativo !== false && !CAMPOS_SKIP.has(c.chave))
        .sort((a, b) => (a.ordem || 0) - (b.ordem || 0));

    campos.forEach(campo => {
        const group = document.createElement('div');
        group.className = 'form-group';
        group.dataset.chave = campo.chave;
        if (campo.obrigatorio) group.classList.add('obrigatorio');

        const label = document.createElement('label');
        label.htmlFor = `campo-${campo.chave}`;
        label.innerHTML = `${escapar(campo.label)}${campo.obrigatorio ? ' <span class="req">*</span>' : ''}`;
        group.appendChild(label);

        if (campo.chave === 'solicitante') {
            label.htmlFor = `campo-${campo.chave}-busca`;
            group.appendChild(criarComboboxEfetivo('solicitante', !!campo.obrigatorio));
            const hint = document.createElement('p');
            hint.className = 'campo-hint';
            hint.id = 'hint-solicitante';
            hint.textContent = 'Digite 3 dígitos da matrícula e escolha na lista.';
            group.appendChild(hint);
        } else if (campo.tipo === 'text' || campo.tipo === 'date') {
            const input = document.createElement('input');
            input.type = campo.tipo === 'date' ? 'date' : 'text';
            input.id = `campo-${campo.chave}`;
            input.name = campo.chave;
            input.required = !!campo.obrigatorio;
            if (campo.tipo === 'date') input.classList.add('date-picker');
            group.appendChild(input);
            if (campo.chave === 'data_solicitacao') {
                const hint = document.createElement('p');
                hint.className = 'campo-hint';
                hint.textContent = 'Informe a data em que a hora extra será realizada.';
                group.appendChild(hint);
            }
        } else if (campo.tipo === 'select' || campo.chave === 'as_code') {
            const select = document.createElement('select');
            select.id = `campo-${campo.chave}`;
            select.name = campo.chave;
            select.required = !!campo.obrigatorio;
            select.innerHTML = '<option value=""></option>';
            const opts = formConfig.opcoes[campo.lista_grupo || campo.chave] || [];
            opts.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.valor;
                opt.textContent = o.label || o.valor;
                select.appendChild(opt);
            });
            group.appendChild(select);
            setupSearchSelect(select);
            label.htmlFor = `campo-${campo.chave}-busca`;

            if (campo.chave === 'as_code') {
                const outrosWrap = document.createElement('div');
                outrosWrap.className = 'campo-outros';
                outrosWrap.hidden = true;
                outrosWrap.innerHTML = `
                    <label for="campo-as_code_outros">Informe a Área de Serviço <span class="req">*</span></label>
                    <input type="text" id="campo-as_code_outros" name="as_code_outros" placeholder="Digite a AS...">
                `;
                group.appendChild(outrosWrap);
                select.addEventListener('change', () => {
                    const isOutros = (select.value || '').toLowerCase() === 'outros';
                    outrosWrap.hidden = !isOutros;
                    if (!isOutros) {
                        const inp = outrosWrap.querySelector('input');
                        if (inp) inp.value = '';
                    }
                    atualizarResumoPrevia();
                });
            }
        } else if (campo.tipo === 'radio') {
            const wrap = document.createElement('div');
            wrap.className = 'radio-group radio-pills';
            const opts = formConfig.opcoes[campo.lista_grupo || campo.chave] || [];
            opts.forEach((o, i) => {
                const lbl = document.createElement('label');
                lbl.className = 'radio-pill';
                const input = document.createElement('input');
                input.type = 'radio';
                input.name = campo.chave;
                input.value = o.valor;
                if (campo.obrigatorio && i === 0) input.required = true;
                if (i === 0) input.checked = true;
                lbl.appendChild(input);
                lbl.appendChild(document.createTextNode(o.label || o.valor));
                wrap.appendChild(lbl);
            });
            group.appendChild(wrap);
        }

        container.appendChild(group);
    });
}

function criarComboboxEfetivo(chave, obrigatorio) {
    const wrap = document.createElement('div');
    wrap.className = 'combobox';
    wrap.dataset.chave = chave;
    wrap.innerHTML = `
        <input type="search" id="campo-${chave}-busca" class="combobox-input" placeholder="Matrícula ou nome" autocomplete="off" ${obrigatorio ? 'required' : ''}>
        <input type="hidden" id="campo-${chave}" name="${chave}">
        <div class="combobox-lista" hidden></div>
        <div class="combobox-selecionado" hidden></div>
    `;
    setupCombobox(wrap, efetivo, (item) => {
        document.getElementById(`campo-${chave}`).value = `${item.matricula} - ${item.nome}`;
        atualizarHintSolicitante(chave, true);
        atualizarResumoPrevia();
    }, () => {
        document.getElementById(`campo-${chave}`).value = '';
        atualizarHintSolicitante(chave, false);
        atualizarResumoPrevia();
    });
    return wrap;
}

/* Depois de escolher, o apoio confirma em vez de repetir a instrução. */
function atualizarHintSolicitante(chave, escolhido) {
    if (chave !== 'solicitante') return;
    const hint = document.getElementById('hint-solicitante');
    if (hint) {
        hint.textContent = escolhido
            ? 'Encontrado no efetivo.'
            : 'Digite 3 dígitos da matrícula e escolha na lista.';
    }
}

function setupCombobox(wrap, listaFonte, onSelect, onClear) {
    const input = wrap.querySelector('input[type="search"], .operador-busca, .combobox-input');
    const hidden = wrap.querySelector('input[type="hidden"]');
    const lista = wrap.querySelector('.combobox-lista');
    const sel = wrap.querySelector('.combobox-selecionado');
    let fonte = listaFonte;

    wrap._setFonte = (arr) => { fonte = arr; };

    function renderLista(q) {
        const ql = (q || '').trim().toLowerCase();
        const filtrados = !ql
            ? fonte.slice(0, 40)
            : fonte.filter(r =>
                (r.matricula || '').toLowerCase().includes(ql) ||
                (r.nome || '').toLowerCase().includes(ql)
            ).slice(0, 40);

        if (!filtrados.length) {
            lista.innerHTML = '<div class="combobox-vazio">Nenhum colaborador encontrado</div>';
            lista.hidden = false;
            return;
        }
        lista.innerHTML = filtrados.map(r => `
            <button type="button" class="combobox-item" data-mat="${escAttr(r.matricula)}" data-nome="${escAttr(r.nome)}">
                <strong>${escapar(r.matricula)}</strong> — ${escapar(r.nome)}
                <span class="combobox-meta">${escapar(r.funcao || '')}</span>
            </button>
        `).join('');
        lista.hidden = false;
        lista.querySelectorAll('.combobox-item').forEach(btn => {
            btn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const item = {
                    matricula: btn.dataset.mat,
                    nome: btn.dataset.nome,
                };
                hidden.value = `${item.matricula}|${item.nome}`;
                if (sel) {
                    sel.hidden = false;
                    sel.innerHTML = `
                        <span>${escapar(item.matricula)} — ${escapar(item.nome)}</span>
                        <button type="button" class="btn-x-mini" title="Limpar">×</button>
                    `;
                    sel.querySelector('.btn-x-mini').addEventListener('click', () => {
                        hidden.value = '';
                        input.value = '';
                        sel.hidden = true;
                        if (onClear) onClear();
                    });
                }
                input.value = '';
                lista.hidden = true;
                marcarInvalido(input, false);
                if (onSelect) onSelect(item);
            });
        });
    }

    input.addEventListener('focus', () => renderLista(input.value));
    input.addEventListener('input', () => renderLista(input.value));
    input.addEventListener('blur', () => setTimeout(() => { lista.hidden = true; }, 150));
}

/* ---------- Funções (lógica preservada) ---------- */
function popularSelect(selectEl) {
    selectEl.innerHTML = '<option value=""></option>';
    funcoes.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        selectEl.appendChild(opt);
    });
    refreshSearchSelect(selectEl);
}

function adicionarBloco() {
    const template = document.getElementById('bloco-template');
    const clone = template.content.cloneNode(true);
    const container = document.getElementById('blocos-container');
    const bloco = clone.querySelector('.bloco-funcao');

    const ordem = container.querySelectorAll('.bloco-funcao').length + 1;
    const titulo = bloco.querySelector('.bloco-item-badge-titulo');
    if (titulo) titulo.textContent = `Função ${ordem}`;

    const select = bloco.querySelector('.funcao-select');
    const qtdInput = bloco.querySelector('.quantidade-input');
    const divColab = bloco.querySelector('.colaboradores-container');
    const buscaBloco = bloco.querySelector('.busca-colab-bloco');

    divColab.blocoDono = bloco;

    popularSelect(select);
    setupSearchSelect(select);

    select.addEventListener('change', () => {
        carregarColaboradores(select.value, divColab, qtdInput, bloco);
        // O título da ficha passa a ser o nome da função escolhida.
        renumerarBlocos();
        atualizarResumoPrevia();
    });

    let buscaBlocoDebounce = null;
    buscaBloco.addEventListener('input', () => {
        clearTimeout(buscaBlocoDebounce);
        buscaBlocoDebounce = setTimeout(() => filtrarColaboradoresBloco(divColab, buscaBloco.value), 200);
    });

    // "Marcar os N filtrados" resolve o caso comum de digitar a equipe inteira.
    bloco.querySelector('.picker-marcar-todos').addEventListener('click', () => {
        divColab.querySelectorAll('label').forEach(label => {
            if (label.style.display === 'none') return;
            const cb = label.querySelector('input[type="checkbox"]');
            if (cb && !cb.checked) cb.checked = true;
        });
        atualizarQuantidade(divColab, qtdInput);
        atualizarResumoPrevia();
    });

    bloco.querySelector('.picker-abrir').addEventListener('click', () => abrirSheet(bloco));

    bloco.querySelector('.btn-remover-bloco').addEventListener('click', () => {
        if (container.querySelectorAll('.bloco-funcao').length <= 1) {
            select.value = '';
            refreshSearchSelect(select);
            divColab.innerHTML = '';
            qtdInput.value = 0;
            buscaBloco.value = '';
            carregarColaboradores('', divColab, qtdInput, bloco);
            atualizarResumoPrevia();
            return;
        }
        bloco.remove();
        renumerarBlocos();
        atualizarResumoPrevia();
    });

    container.appendChild(bloco);
    renumerarBlocos();
    requestAnimationFrame(() => bloco.classList.add('bloco-enter'));
}

/* O número na margem de talão é a posição da ficha, não o id do bloco. */
function renumerarBlocos() {
    document.querySelectorAll('#blocos-container .bloco-funcao').forEach((bloco, i) => {
        const num = bloco.querySelector('.bloco-talao-num');
        if (num) num.textContent = String(i + 1).padStart(2, '0');
        const titulo = bloco.querySelector('.bloco-item-badge-titulo');
        const funcao = bloco.querySelector('.funcao-select')?.value;
        if (titulo) titulo.textContent = funcao || `Função ${i + 1}`;
    });
}

/* A ficha dona da lista, mesmo enquanto ela está dentro da seleção em tela cheia. */
function blocoDe(container) {
    return container.blocoDono || container.closest('.bloco-funcao');
}

async function carregarColaboradores(funcao, container, qtdInput, bloco) {
    container.blocoDono = bloco;
    const picker = bloco.querySelector('.picker');
    const semFuncao = bloco.querySelector('.bloco-sem-funcao');
    const sub = bloco.querySelector('.bloco-funcao-sub');

    if (!funcao) {
        container.innerHTML = '';
        container.dataset.total = '0';
        if (picker) picker.hidden = true;
        if (semFuncao) semFuncao.hidden = false;
        if (sub) sub.textContent = 'Marque quem participa de cada função.';
        atualizarQuantidade(container, qtdInput);
        return;
    }

    if (picker) picker.hidden = false;
    if (semFuncao) semFuncao.hidden = true;
    if (sub) sub.textContent = 'Marque quem participa desta função.';

    try {
        const res = await fetch(`/api/colaboradores?funcao=${encodeURIComponent(funcao)}`);
        const colaboradores = await res.json();
        container.innerHTML = '';
        (colaboradores || []).forEach(col => {
            container.appendChild(criarLinhaColaborador(col, () => {
                atualizarQuantidade(container, qtdInput);
                atualizarResumoPrevia();
            }));
        });
        container.dataset.total = String((colaboradores || []).length);
        filtrarColaboradoresBloco(container, bloco?.querySelector('.busca-colab-bloco')?.value);
        atualizarQuantidade(container, qtdInput);
    } catch {
        container.innerHTML = '<span class="erro-inline">Erro ao carregar colaboradores</span>';
    }
}

/* A matrícula é sempre visível: homônimos só se distinguem por ela. */
function criarLinhaColaborador(col, aoMudar) {
    const label = document.createElement('label');
    label.dataset.matricula = (col.matricula || '').toLowerCase();
    label.dataset.nome = (col.nome || '').toLowerCase();

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = col.nome;
    checkbox.dataset.matricula = col.matricula;
    checkbox.dataset.nome = col.nome;
    checkbox.addEventListener('change', aoMudar);
    label.appendChild(checkbox);

    const texto = document.createElement('span');
    texto.className = 'colab-texto';

    const nome = document.createElement('span');
    nome.className = 'colab-nome';
    nome.textContent = col.nome || '';

    const matricula = document.createElement('span');
    matricula.className = 'colab-matricula';
    matricula.textContent = col.matricula || '';

    // No mouse a matrícula vem antes do nome; no toque, embaixo dele.
    texto.appendChild(matricula);
    texto.appendChild(nome);
    label.appendChild(texto);

    const aviso = document.createElement('span');
    aviso.className = 'colab-em-outra';
    aviso.hidden = true;
    label.appendChild(aviso);

    return label;
}

function filtrarColaboradoresBloco(container, q) {
    const termo = (q || '').trim();
    const ql = termo.toLowerCase();
    let visiveis = 0;
    container.querySelectorAll('label').forEach(label => {
        const mat = label.dataset.matricula || '';
        const nome = label.dataset.nome || '';
        const passa = !ql || mat.includes(ql) || nome.includes(ql);
        label.style.display = passa ? '' : 'none';
        if (passa) visiveis++;
    });
    // O termo volta como foi digitado — repetir em minúsculas parece erro.
    atualizarTopoPicker(container, visiveis, termo);
}

/* Vazio de filtro: repete o termo buscado e aponta as duas causas reais. */
function atualizarTopoPicker(container, visiveis, termo) {
    const bloco = blocoDe(container);
    if (!bloco) return;
    const total = Number(container.dataset.total || 0);

    const resultado = bloco.querySelector('.picker-resultado');
    if (resultado) resultado.textContent = total ? `${visiveis} de ${total}` : '';

    const btnTodos = bloco.querySelector('.picker-marcar-todos');
    if (btnTodos) {
        btnTodos.textContent = `Marcar os ${visiveis} filtrados`;
        btnTodos.hidden = visiveis === 0;
    }

    let vazio = container.querySelector('.colab-vazio');
    if (total && visiveis === 0) {
        if (!vazio) {
            vazio = document.createElement('div');
            vazio.className = 'colab-vazio';
            vazio.innerHTML = '<div class="colab-vazio-titulo"></div>'
                + '<div class="colab-vazio-texto">Confira a matrícula ou procure em outra função.</div>';
            container.appendChild(vazio);
        }
        vazio.querySelector('.colab-vazio-titulo').textContent = `Nenhum colaborador com “${termo}”`;
    } else if (vazio) {
        vazio.remove();
    }
}

function atualizarQuantidade(container, qtdInput) {
    const bloco = blocoDe(container);
    const marcados = Array.from(container.querySelectorAll('input[type="checkbox"]:checked'));
    qtdInput.value = marcados.length;
    if (!bloco) return;

    const caixa = bloco.querySelector('.bloco-item-count');
    if (caixa) {
        caixa.classList.toggle('tem-gente', marcados.length > 0);
        caixa.querySelector('.conta').textContent = marcados.length;
        caixa.querySelector('.conta-label').textContent =
            marcados.length === 1 ? 'colaborador marcado' : 'colaboradores marcados';
    }

    const botao = bloco.querySelector('.picker-abrir');
    if (botao) botao.textContent = marcados.length ? 'Marcar mais colaboradores' : 'Marcar colaboradores';

    renderMarcados(bloco, marcados);
    atualizarAvisosOutraFuncao();
    atualizarSheet();
    atualizarNavHint();
}

/* A coluna da direita responde "quem já está marcado", na ordem da marcação. */
function renderMarcados(bloco, marcados) {
    const chips = bloco.querySelector('.picker-chips');
    const lista = bloco.querySelector('.picker-marcados-lista');
    if (chips) chips.innerHTML = '';
    if (lista) lista.innerHTML = '';

    if (lista && !marcados.length) {
        const vazio = document.createElement('div');
        vazio.className = 'picker-marcados-vazio';
        vazio.textContent = 'Clique nos nomes à esquerda. Eles aparecem aqui na ordem em que forem marcados.';
        lista.appendChild(vazio);
    }

    marcados.forEach(cb => {
        const matricula = cb.dataset.matricula || '';
        const nome = cb.dataset.nome || cb.value || '';
        const desmarcar = () => {
            cb.checked = false;
            cb.dispatchEvent(new Event('change'));
        };

        if (chips) {
            const chip = document.createElement('div');
            chip.className = 'picker-chip';
            chip.innerHTML = `<span class="picker-chip-matricula"></span>`
                + `<span class="picker-chip-nome"></span>`
                + `<button type="button" class="picker-chip-x" aria-label="Desmarcar">×</button>`;
            chip.querySelector('.picker-chip-matricula').textContent = matricula;
            chip.querySelector('.picker-chip-nome').textContent = nome;
            chip.querySelector('.picker-chip-x').addEventListener('click', desmarcar);
            chips.appendChild(chip);
        }

        if (lista) {
            const linha = document.createElement('div');
            linha.className = 'picker-marcado';
            linha.innerHTML = `<span class="picker-marcado-matricula"></span>`
                + `<span class="picker-marcado-nome"></span>`
                + `<button type="button" class="picker-marcado-x" aria-label="Desmarcar">×</button>`;
            linha.querySelector('.picker-marcado-matricula').textContent = matricula;
            linha.querySelector('.picker-marcado-nome').textContent = nome;
            linha.querySelector('.picker-marcado-x').addEventListener('click', desmarcar);
            lista.appendChild(linha);
        }
    });
}

/* Quem já está em outra função da mesma solicitação continua selecionável —
   o encarregado só precisa ver antes de errar de pessoa. */
function atualizarAvisosOutraFuncao() {
    const onde = new Map();
    document.querySelectorAll('#blocos-container .bloco-funcao').forEach(bloco => {
        const funcao = bloco.querySelector('.funcao-select')?.value || '';
        listaDoBloco(bloco)?.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            const chave = cb.dataset.matricula;
            if (!onde.has(chave)) onde.set(chave, []);
            onde.get(chave).push({ bloco, funcao });
        });
    });

    document.querySelectorAll('#blocos-container .bloco-funcao').forEach(bloco => {
        listaDoBloco(bloco)?.querySelectorAll('label').forEach(label => {
            const cb = label.querySelector('input[type="checkbox"]');
            const aviso = label.querySelector('.colab-em-outra');
            if (!cb || !aviso) return;
            const outros = (onde.get(cb.dataset.matricula) || []).filter(o => o.bloco !== bloco);
            if (outros.length) {
                aviso.hidden = false;
                aviso.textContent = `Já em ${outros[0].funcao || 'outra função'}`;
                label.dataset.outraFuncao = outros[0].funcao || 'outra função';
            } else {
                aviso.hidden = true;
                aviso.textContent = '';
                delete label.dataset.outraFuncao;
            }
        });
    });
}

/* ---------- Seleção em tela cheia (toque) ----------
   A lista é a mesma do painel do desktop: movemos o container para dentro da
   folha e o devolvemos ao fechar, para que exista uma única fonte de verdade. */
let sheetBlocoAtual = null;
let sheetOrigem = null;
let sheetBuscaDebounce = null;

function abrirSheet(bloco) {
    const sheet = document.getElementById('sheet-colaboradores');
    const container = bloco.querySelector('.colaboradores-container');
    if (!sheet || !container) return;

    sheetBlocoAtual = bloco;
    sheetOrigem = container.parentElement;
    container.classList.add('modo-toque');
    document.getElementById('sheet-corpo').appendChild(container);

    const funcao = bloco.querySelector('.funcao-select')?.value || 'Função';
    const total = Number(container.dataset.total || 0);
    document.getElementById('sheet-titulo').textContent = funcao;
    document.getElementById('sheet-sub').textContent = `${total} habilitados no efetivo`;

    const busca = document.getElementById('sheet-busca');
    busca.value = bloco.querySelector('.busca-colab-bloco')?.value || '';
    filtrarColaboradoresBloco(container, busca.value);

    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    atualizarSheet();
    busca.focus();
}

function fecharSheet() {
    const sheet = document.getElementById('sheet-colaboradores');
    if (!sheet || sheet.hidden) return;
    const container = sheet.querySelector('.colaboradores-container');
    if (container && sheetOrigem) {
        container.classList.remove('modo-toque');
        sheetOrigem.appendChild(container);
        filtrarColaboradoresBloco(container, sheetBlocoAtual?.querySelector('.busca-colab-bloco')?.value);
    }
    sheet.hidden = true;
    document.body.style.overflow = '';
    // A seleção devolve o foco ao botão que a abriu.
    sheetBlocoAtual?.querySelector('.picker-abrir')?.focus();
    sheetBlocoAtual = null;
    sheetOrigem = null;
}

function atualizarSheet() {
    const sheet = document.getElementById('sheet-colaboradores');
    if (!sheet || sheet.hidden || !sheetBlocoAtual) return;
    const n = sheet.querySelectorAll('.colaboradores-container input[type="checkbox"]:checked').length;
    document.getElementById('sheet-qtd').textContent = n;
    document.getElementById('sheet-confirmar').textContent = n ? `Confirmar ${n}` : 'Concluir';
}

function initSheet() {
    const sheet = document.getElementById('sheet-colaboradores');
    if (!sheet) return;
    document.getElementById('sheet-fechar').addEventListener('click', fecharSheet);
    document.getElementById('sheet-confirmar').addEventListener('click', fecharSheet);
    document.getElementById('sheet-busca').addEventListener('input', e => {
        clearTimeout(sheetBuscaDebounce);
        const valor = e.target.value;
        sheetBuscaDebounce = setTimeout(() => {
            const container = sheet.querySelector('.colaboradores-container');
            if (container) filtrarColaboradoresBloco(container, valor);
        }, 200);
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !sheet.hidden) fecharSheet();
    });
}

/* ---------- Equipamentos ---------- */
function popularSelectEquipamento(selectEl) {
    selectEl.innerHTML = '<option value=""></option>';
    const opts = formConfig.opcoes.equipamento || [];
    opts.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.valor;
        opt.textContent = o.label || o.valor;
        selectEl.appendChild(opt);
    });
    refreshSearchSelect(selectEl);
}

function adicionarBlocoEquipamento() {
    const template = document.getElementById('equipamento-template');
    const clone = template.content.cloneNode(true);
    const container = document.getElementById('equipamentos-container');
    const bloco = clone.querySelector('.bloco-equipamento');

    const badge = bloco.querySelector('.bloco-item-badge');
    if (badge) badge.textContent = `Equipamento ${container.querySelectorAll('.bloco-equipamento').length + 1}`;

    const selectEq = bloco.querySelector('.equipamento-select');
    popularSelectEquipamento(selectEq);
    setupSearchSelect(selectEq);
    selectEq.addEventListener('change', atualizarResumoPrevia);

    const combo = bloco.querySelector('.combobox');
    setupCombobox(combo, efetivo, () => atualizarResumoPrevia(), () => atualizarResumoPrevia());

    bloco.querySelector('.btn-remover-bloco').addEventListener('click', () => {
        bloco.remove();
        renumerarEquipamentos();
        atualizarEquipamentosVazio();
        atualizarResumoPrevia();
    });

    container.appendChild(bloco);
    requestAnimationFrame(() => bloco.classList.add('bloco-enter'));
}

function renumerarEquipamentos() {
    document.querySelectorAll('#equipamentos-container .bloco-equipamento').forEach((bloco, i) => {
        const badge = bloco.querySelector('.bloco-item-badge');
        if (badge) badge.textContent = `Equipamento ${i + 1}`;
    });
}

/* A etapa 3 é opcional de verdade: começa vazia, e o vazio explica o que fazer. */
function atualizarEquipamentosVazio() {
    const vazio = document.getElementById('equipamentos-vazio');
    if (!vazio) return;
    vazio.hidden = document.querySelectorAll('#equipamentos-container .bloco-equipamento').length > 0;
}

function coletarEquipamentos() {
    const lista = [];
    document.querySelectorAll('.bloco-equipamento').forEach(bloco => {
        const equipamento = bloco.querySelector('.equipamento-select')?.value || '';
        const hidden = bloco.querySelector('.operador-valor');
        const raw = (hidden?.value || '').trim();
        if (!equipamento && !raw) return;
        let operador = null;
        if (raw.includes('|')) {
            const [matricula, nome] = raw.split('|');
            operador = { matricula: matricula.trim(), nome: nome.trim(), a_procura: false };
        }
        if (equipamento) {
            lista.push({
                equipamento,
                operador,
                colaboradores: operador ? [operador] : [],
            });
        }
    });
    return lista;
}

/* ---------- Coleta / validação / envio ---------- */
function coletarCamposForm() {
    const payload = {};
    (formConfig.campos || []).forEach(campo => {
        if (CAMPOS_SKIP.has(campo.chave) || campo.tipo === 'funcoes') return;

        if (campo.chave === 'solicitante') {
            payload.solicitante = document.getElementById('campo-solicitante')?.value || '';
            return;
        }
        if (campo.tipo === 'radio') {
            payload[campo.chave] = document.querySelector(`input[name="${campo.chave}"]:checked`)?.value || '';
        } else {
            const el = document.getElementById(`campo-${campo.chave}`);
            payload[campo.chave] = el ? el.value : '';
        }
    });

    // AS Outros
    if ((payload.as_code || '').toLowerCase() === 'outros') {
        const outros = document.getElementById('campo-as_code_outros')?.value?.trim() || '';
        payload.as_code = outros;
        payload.as_code_outros = outros;
    }
    payload.observacao = document.getElementById('campo-observacao')?.value || '';
    return payload;
}

function coletarItensFuncoes() {
    const itens = [];
    document.querySelectorAll('.bloco-funcao').forEach(bloco => {
        const funcao = bloco.querySelector('.funcao-select').value;
        if (!funcao) return;
        const checkboxes = listaDoBloco(bloco)?.querySelectorAll('input[type="checkbox"]:checked') || [];
        const colaboradores = Array.from(checkboxes).map(cb => ({
            matricula: cb.dataset.matricula,
            nome: cb.dataset.nome || cb.value,
            a_procura: false,
        }));
        if (!colaboradores.length) return;
        const quantidade = parseInt(bloco.querySelector('.quantidade-input').value, 10) || colaboradores.length;
        itens.push({ funcao, quantidade, colaboradores, tipo: 'funcao' });
    });
    return itens;
}

function validarCamposObrigatorios(campos) {
    let ok = true;
    let msg = '';

    for (const campo of formConfig.campos || []) {
        if (CAMPOS_SKIP.has(campo.chave) || campo.tipo === 'funcoes' || !campo.obrigatorio || campo.ativo === false) continue;

        let el = document.getElementById(`campo-${campo.chave}`);
        let valor = campos[campo.chave];

        if (campo.chave === 'solicitante') {
            el = document.getElementById('campo-solicitante-busca') || document.querySelector('[data-chave="solicitante"] .combobox-input');
            valor = campos.solicitante;
        }
        if (campo.chave === 'as_code') {
            const sel = document.getElementById('campo-as_code');
            if ((sel?.value || '').toLowerCase() === 'outros') {
                el = document.getElementById('campo-as_code_outros');
                valor = campos.as_code;
            }
        }

        const vazio = !valor;
        marcarInvalido(el, vazio, vazio ? msgDoCampo(campo) : '');
        if (vazio) {
            ok = false;
            msg = msg || `Falta preencher: ${campo.label}.`;
        }
    }

    return { ok, msg };
}

function validarFormulario(campos, itens, equipamentos) {
    mostrarErro('');
    const { ok: camposOk, msg: camposMsg } = validarCamposObrigatorios(campos);
    let ok = camposOk;
    let msg = camposMsg;

    if (!validarEtapa3()) {
        ok = false;
        msg = msg || document.getElementById('form-erro')?.textContent || 'Verifique os equipamentos informados.';
    }

    if (!itens.length && !equipamentos.length) {
        ok = false;
        msg = msg || 'Adicione pelo menos uma função com colaboradores ou um equipamento.';
    }

    if (!ok) mostrarErro(msg);
    return ok;
}

function agendarResumoPrevia() {
    clearTimeout(previaDebounce);
    previaDebounce = setTimeout(atualizarResumoPrevia, 200);
}

function atualizarResumoPrevia() {
    const box = document.getElementById('resumo-previa');
    const campos = coletarCamposForm();
    const itens = coletarItensFuncoes();
    const equipamentos = coletarEquipamentos();
    const pessoas = totalPessoasMarcadas();

    const resumoCampos = [
        ['Solicitante', campos.solicitante],
        ['Setor', campos.setor_solicitante],
        ['AS', campos.as_code],
        ['Data', formatarDataBr(campos.data_solicitacao)],
        ['Turno', campos.turno],
        ['Pessoas', pessoas ? String(pessoas) : ''],
    ];

    atualizarFichaLateral(resumoCampos, pessoas, itens.length);
    if (!box) return;

    const completo = campos.solicitante && campos.setor_solicitante && campos.as_code && itens.length;
    if (!completo) {
        // Estado vazio que diz exatamente o que falta.
        box.innerHTML = `
            <div class="ficha-vazia">
                <div class="ficha-vazia-titulo">Sem resumo ainda</div>
                <div class="ficha-vazia-texto">Complete a etapa 1 e marque pelo menos um colaborador na etapa 2.</div>
                <button type="button" class="btn-primary" id="resumo-voltar-etapa1">Voltar para a etapa 1</button>
            </div>`;
        box.querySelector('#resumo-voltar-etapa1')?.addEventListener('click', () => mostrarEtapa(1));
        return;
    }

    const grade = resumoCampos
        .map(([k, v]) => `<div><dt>${escapar(k)}</dt><dd>${escapar(v || '—')}</dd></div>`)
        .join('');

    const grupos = itens.map(it => {
        const nomes = (it.colaboradores || [])
            .map(c => `${c.nome} (${c.matricula})`)
            .join(' · ');
        const qtd = (it.colaboradores || []).length;
        return `
            <div class="ficha-grupo">
                <div class="ficha-grupo-topo">
                    <span class="ficha-grupo-nome">${escapar(it.funcao)}</span>
                    <span class="ficha-grupo-qtd">${qtd} ${qtd === 1 ? 'pessoa' : 'pessoas'}</span>
                </div>
                <div class="ficha-grupo-corpo">${escapar(nomes)}</div>
            </div>`;
    }).join('');

    const equipHtml = equipamentos.length ? `
        <div class="ficha-grupo neutro">
            <div class="ficha-grupo-topo"><span class="ficha-grupo-nome">Equipamentos</span></div>
            <div class="ficha-grupo-corpo">${escapar(equipamentos.map(eq => {
                const op = eq.operador ? `${eq.operador.nome} (${eq.operador.matricula})` : '';
                return eq.equipamento + (op ? ` — ${op}` : '');
            }).join(' · '))}</div>
        </div>` : '';

    const obsHtml = campos.observacao ? `
        <div class="ficha-grupo neutro">
            <div class="ficha-grupo-topo"><span class="ficha-grupo-nome">Observação</span></div>
            <div class="ficha-grupo-corpo">${escapar(campos.observacao)}</div>
        </div>` : '';

    box.innerHTML = `<dl class="ficha-dl">${grade}</dl>`
        + `<div class="ficha-grupos">${grupos}${equipHtml}${obsHtml}</div>`;
}

/* Trilho lateral: a ficha em andamento, visível enquanto se preenche. */
function atualizarFichaLateral(resumoCampos, pessoas, funcoes) {
    const dl = document.getElementById('wizard-aside-campos');
    if (!dl) return;
    dl.innerHTML = resumoCampos
        .filter(([, v]) => !!v)
        .map(([k, v]) => `<div class="wizard-aside-linha"><dt>${escapar(k)}</dt><dd>${escapar(v)}</dd></div>`)
        .join('') || '<div class="wizard-aside-linha"><dt>Ficha</dt><dd>em branco</dd></div>';

    const total = document.getElementById('wizard-aside-total');
    if (total) total.textContent = pessoas;
    const label = document.getElementById('wizard-aside-total-label');
    if (label) {
        label.textContent = funcoes
            ? `colaboradores marcados em ${funcoes} ${funcoes === 1 ? 'função' : 'funções'}`
            : 'colaboradores marcados';
    }
}

function formatarDataBr(iso) {
    if (!iso) return '';
    const p = String(iso).split('-');
    return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
}

async function enviarSolicitacao(e) {
    e.preventDefault();
    if (etapaAtual !== TOTAL_ETAPAS) return;

    const campos = coletarCamposForm();
    const itens = coletarItensFuncoes();
    const equipamentos = coletarEquipamentos();

    if (!validarFormulario(campos, itens, equipamentos)) {
        irParaPrimeiroErro();
        return;
    }

    // Primeiro equipamento preenche o campo legado no cabeçalho do resumo
    if (equipamentos.length && !campos.equipamento) {
        campos.equipamento = equipamentos[0].equipamento;
    }

    const payload = { ...campos, itens, equipamentos };
    const btn = document.getElementById('btn-enviar');
    // O botão permanece com texto, desabilitado, com indicador: some a dúvida
    // de ter tocado ou não.
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Enviando…';
    limparFalhaEnvio();
    try {
        const res = await fetch('/api/solicitacoes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
            mostrarErro(data.error || 'O servidor recusou a solicitação. Confira os dados e envie de novo.');
            return;
        }
        window.location.href = `/solicitacao/${data.id}/resumo`;
    } catch (err) {
        console.error(err);
        mostrarFalhaEnvio(e);
    } finally {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.textContent = 'Enviar solicitação';
    }
}

/* Falha de rede: diz onde os dados estão e qual é o próximo passo.
   Nada some da tela. */
function mostrarFalhaEnvio(eventoOriginal) {
    limparFalhaEnvio();
    const alvo = document.querySelector('.form-actions');
    if (!alvo) return;
    const faixa = document.createElement('div');
    faixa.className = 'aviso-linha';
    faixa.id = 'aviso-falha-envio';
    faixa.setAttribute('role', 'alert');
    faixa.innerHTML = `
        <div style="flex:1;">
            <div class="aviso-linha-titulo">O envio não chegou ao servidor</div>
            <div class="aviso-linha-texto">A solicitação continua preenchida nesta tela. Assim que houver sinal, toque em “Tentar de novo” — nada foi perdido.</div>
            <button type="button" class="btn-primary" id="btn-tentar-de-novo">Tentar de novo</button>
        </div>`;
    alvo.prepend(faixa);
    faixa.querySelector('#btn-tentar-de-novo').addEventListener('click', () => {
        enviarSolicitacao(eventoOriginal || new Event('submit'));
    });
    faixa.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function limparFalhaEnvio() {
    document.getElementById('aviso-falha-envio')?.remove();
}

function escapar(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function escAttr(s) {
    return escapar(s).replace(/'/g, '&#39;');
}
