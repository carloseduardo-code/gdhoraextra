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
        atualizarResumoPrevia();
    });
    document.getElementById('solicitacao-form').addEventListener('submit', enviarSolicitacao);
    document.getElementById('solicitacao-form').addEventListener('input', agendarResumoPrevia);
    document.getElementById('solicitacao-form').addEventListener('change', agendarResumoPrevia);

    initWizard();
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
    const navHint = document.getElementById('wizard-nav-hint');
    if (navHint) navHint.textContent = n === TOTAL_ETAPAS ? 'Revise antes de enviar' : `Etapa ${n} de ${TOTAL_ETAPAS}`;

    if (n === TOTAL_ETAPAS) atualizarResumoPrevia();

    if (!opts?.semScroll) {
        const form = document.getElementById('solicitacao-form');
        if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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

function marcarInvalido(el, invalido) {
    if (!el) return;
    const group = el.closest('.form-group') || el.closest('.combobox')?.parentElement;
    if (group) group.classList.toggle('campo-invalido', !!invalido);
    el.classList.toggle('is-invalid', !!invalido);
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
        <input type="search" id="campo-${chave}-busca" class="combobox-input" placeholder="Pesquisar por matrícula ou nome..." autocomplete="off" ${obrigatorio ? 'required' : ''}>
        <input type="hidden" id="campo-${chave}" name="${chave}">
        <div class="combobox-lista" hidden></div>
        <div class="combobox-selecionado" hidden></div>
    `;
    setupCombobox(wrap, efetivo, (item) => {
        document.getElementById(`campo-${chave}`).value = `${item.matricula} - ${item.nome}`;
        atualizarResumoPrevia();
    }, () => {
        document.getElementById(`campo-${chave}`).value = '';
        atualizarResumoPrevia();
    });
    return wrap;
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

    const badge = bloco.querySelector('.bloco-item-badge');
    if (badge) badge.textContent = `Função ${container.querySelectorAll('.bloco-funcao').length + 1}`;

    const select = bloco.querySelector('.funcao-select');
    const qtdInput = bloco.querySelector('.quantidade-input');
    const divColab = bloco.querySelector('.colaboradores-container');
    const buscaBloco = bloco.querySelector('.busca-colab-bloco');

    popularSelect(select);
    setupSearchSelect(select);

    select.addEventListener('change', () => {
        carregarColaboradores(select.value, divColab, qtdInput, bloco);
        atualizarResumoPrevia();
    });

    let buscaBlocoDebounce = null;
    buscaBloco.addEventListener('input', () => {
        clearTimeout(buscaBlocoDebounce);
        buscaBlocoDebounce = setTimeout(() => filtrarColaboradoresBloco(divColab, buscaBloco.value), 200);
    });

    bloco.querySelector('.btn-remover-bloco').addEventListener('click', () => {
        if (container.querySelectorAll('.bloco-funcao').length <= 1) {
            select.value = '';
            divColab.innerHTML = '';
            qtdInput.value = 0;
            buscaBloco.value = '';
            atualizarResumoPrevia();
            return;
        }
        bloco.remove();
        atualizarResumoPrevia();
    });

    container.appendChild(bloco);
    requestAnimationFrame(() => bloco.classList.add('bloco-enter'));
}

async function carregarColaboradores(funcao, container, qtdInput, bloco) {
    if (!funcao) {
        container.innerHTML = '';
        atualizarQuantidade(container, qtdInput);
        return;
    }
    try {
        const res = await fetch(`/api/colaboradores?funcao=${encodeURIComponent(funcao)}`);
        const colaboradores = await res.json();
        container.innerHTML = '';
        (colaboradores || []).forEach(col => {
            const label = document.createElement('label');
            label.dataset.matricula = (col.matricula || '').toLowerCase();
            label.dataset.nome = (col.nome || '').toLowerCase();
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = col.nome;
            checkbox.dataset.matricula = col.matricula;
            checkbox.dataset.nome = col.nome;
            checkbox.addEventListener('change', () => {
                atualizarQuantidade(container, qtdInput);
                atualizarResumoPrevia();
            });
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(` ${col.matricula} - ${col.nome}`));
            container.appendChild(label);
        });
        filtrarColaboradoresBloco(container, bloco?.querySelector('.busca-colab-bloco')?.value);
        atualizarQuantidade(container, qtdInput);
    } catch {
        container.innerHTML = '<span class="erro-inline">Erro ao carregar colaboradores</span>';
    }
}

function filtrarColaboradoresBloco(container, q) {
    const ql = (q || '').trim().toLowerCase();
    container.querySelectorAll('label').forEach(label => {
        if (!ql) {
            label.style.display = '';
            return;
        }
        const mat = label.dataset.matricula || '';
        const nome = label.dataset.nome || '';
        label.style.display = (mat.includes(ql) || nome.includes(ql)) ? '' : 'none';
    });
}

function atualizarQuantidade(container, qtdInput) {
    const checked = container.querySelectorAll('input[type="checkbox"]:checked').length;
    qtdInput.value = checked;
    const badge = container.closest('.bloco-funcao')?.querySelector('.bloco-item-count');
    if (badge) badge.textContent = checked;
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
        atualizarResumoPrevia();
    });

    container.appendChild(bloco);
    requestAnimationFrame(() => bloco.classList.add('bloco-enter'));
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
        const checkboxes = bloco.querySelectorAll('.colaboradores-container input:checked');
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
        marcarInvalido(el, vazio);
        if (vazio) {
            ok = false;
            msg = msg || `Preencha o campo: ${campo.label}`;
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
    if (!box) return;
    const campos = coletarCamposForm();
    const itens = coletarItensFuncoes();
    const equipamentos = coletarEquipamentos();

    const linhas = [];
    if (campos.solicitante) linhas.push(`<div><strong>Solicitante:</strong> ${escapar(campos.solicitante)}</div>`);
    if (campos.setor_solicitante) linhas.push(`<div><strong>Setor:</strong> ${escapar(campos.setor_solicitante)}</div>`);
    if (campos.as_code) linhas.push(`<div><strong>AS:</strong> ${escapar(campos.as_code)}</div>`);
    if (campos.data_solicitacao) {
        const p = String(campos.data_solicitacao).split('-');
        const dataBr = p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : campos.data_solicitacao;
        linhas.push(`<div><strong>Data:</strong> ${escapar(dataBr)}</div>`);
    }
    if (campos.turno) linhas.push(`<div><strong>Turno:</strong> ${escapar(campos.turno)}</div>`);

    if (itens.length) {
        linhas.push('<hr><strong>Funções</strong>');
        itens.forEach(it => {
            const nomes = (it.colaboradores || []).map(c => `${c.matricula} - ${c.nome}`).join(', ');
            linhas.push(`<div>• <strong>${escapar(it.funcao)}</strong> (${it.quantidade}): ${escapar(nomes)}</div>`);
        });
    }

    if (equipamentos.length) {
        linhas.push('<hr><strong>Equipamentos</strong>');
        equipamentos.forEach(eq => {
            const op = eq.operador ? `${eq.operador.matricula} - ${eq.operador.nome}` : '—';
            linhas.push(`<div>• <strong>${escapar(eq.equipamento)}</strong> → ${escapar(op)}</div>`);
        });
    }

    if (campos.observacao) {
        linhas.push('<hr><strong>Observação</strong>');
        linhas.push(`<div>${escapar(campos.observacao)}</div>`);
    }

    box.innerHTML = linhas.length
        ? linhas.join('')
        : '<span class="hint">Preencha o formulário para ver o resumo.</span>';
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
    btn.disabled = true;
    btn.textContent = 'Enviando...';
    try {
        const res = await fetch('/api/solicitacoes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
            mostrarErro(data.error || 'Erro ao enviar. Tente novamente.');
            return;
        }
        window.location.href = `/solicitacao/${data.id}/resumo`;
    } catch (err) {
        console.error(err);
        mostrarErro('Erro de comunicação com o servidor.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enviar Solicitação';
    }
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
