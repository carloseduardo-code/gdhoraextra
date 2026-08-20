let debounce = null;
let termoAtual = '';
let dataAtual = '';
let solsAtuais = new Map();
let edicaoAbertaId = null;

let formConfigCache = null;
let funcoesCache = null;
let efetivoCache = null;
let dadosEdicaoPromise = null;

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const TURNO_CSS = { 'Dia': 't-dia', 'Noite': 't-noite', 'Extensão de Horário': 't-ext' };

document.addEventListener('DOMContentLoaded', () => {
    carregar('');
    const busca = document.getElementById('busca');
    busca.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => carregar(busca.value.trim(), dataAtual), 250);
    });
    document.getElementById('btn-exportar').addEventListener('click', exportarExcel);

    const filtroData = document.getElementById('filtro-data');
    const btnLimparData = document.getElementById('btn-limpar-data');
    filtroData.addEventListener('change', () => {
        btnLimparData.hidden = !filtroData.value;
        carregar(termoAtual, filtroData.value);
    });
    btnLimparData.addEventListener('click', () => {
        filtroData.value = '';
        btnLimparData.hidden = true;
        carregar(termoAtual, '');
    });
});

async function carregar(q, data) {
    termoAtual = q || '';
    dataAtual = data ?? dataAtual;
    const box = document.getElementById('lista-solicitacoes');
    const countLabel = document.getElementById('sol-count-label');
    box.innerHTML = '<p class="hint">Carregando...</p>';
    try {
        const params = new URLSearchParams({ q: termoAtual });
        if (dataAtual) params.set('data', dataAtual);
        const res = await fetch('/api/admin/solicitacoes?' + params.toString());
        const dados = await res.json();
        if (!res.ok) throw new Error(dados.error || 'Erro');

        // Depois de carregar, o rótulo vira informação útil em vez de sumir.
        if (countLabel) {
            const pessoas = new Set();
            dados.forEach(sol => (sol.solicitacao_itens || []).forEach(item => {
                (item.colaboradores || []).forEach(c => pessoas.add(c.matricula || c.nome));
            }));
            countLabel.textContent = `${dados.length} ${dados.length === 1 ? 'solicitação' : 'solicitações'}`
                + ` · ${pessoas.size} ${pessoas.size === 1 ? 'colaborador envolvido' : 'colaboradores envolvidos'}`;
        }

        solsAtuais = new Map(dados.map(s => [String(s.id), s]));
        edicaoAbertaId = null;

        const cabecalho = document.getElementById('sol-lista-cabecalho');

        if (!dados.length) {
            // O vazio é do filtro, não do sistema — e a ação vem junto.
            if (cabecalho) cabecalho.hidden = true;
            const alvo = dataAtual
                ? `Nenhuma solicitação em ${formatarData(dataAtual)}`
                : (termoAtual ? `Nenhuma solicitação com “${escapar(termoAtual)}”` : 'Nenhuma solicitação registrada');
            box.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-title">${alvo}</div>
                    <div class="empty-state-hint">Troque a data ou limpe o filtro para ver os pedidos das outras datas.</div>
                    <button type="button" class="btn-secondary" id="btn-limpar-filtros" style="margin-top:14px;">Limpar filtros</button>
                </div>`;
            box.querySelector('#btn-limpar-filtros')?.addEventListener('click', () => {
                const busca = document.getElementById('busca');
                const filtroData = document.getElementById('filtro-data');
                const btnLimparData = document.getElementById('btn-limpar-data');
                if (busca) busca.value = '';
                if (filtroData) filtroData.value = '';
                if (btnLimparData) btnLimparData.hidden = true;
                carregar('', '');
            });
            return;
        }
        if (cabecalho) cabecalho.hidden = false;
        box.innerHTML = dados.map(criarLinha).join('');

        box.querySelectorAll('.sol-row').forEach(row => {
            const id = row.dataset.id;
            const toggle = row.querySelector('.sol-toggle');
            const body = row.querySelector('.sol-row-body');
            const alternar = () => {
                const abrir = body.hidden;
                body.hidden = !abrir;
                toggle.classList.toggle('open', abrir);
            };
            toggle.addEventListener('click', e => { e.stopPropagation(); alternar(); });
            // A linha inteira abre a ficha: é o alvo que o RH mira.
            row.querySelector('.sol-row-head').addEventListener('click', alternar);
            row.querySelector('.btn-copiar-texto')?.addEventListener('click', () => copiarTexto(row.dataset.texto || ''));
            row.querySelector('.btn-apagar')?.addEventListener('click', () => apagarSolicitacao(id));
            row.querySelector('.btn-editar')?.addEventListener('click', () => alternarEdicao(row, id));
        });
    } catch (e) {
        box.innerHTML = `<p class="hint">Erro: ${escapar(e.message)}</p>`;
    }
}

function criarLinha(sol) {
    const itens = sol.solicitacao_itens || [];
    const turno = sol.turno || 'Dia';
    const turnoCss = TURNO_CSS[turno] || 't-dia';
    const qtd = itens.reduce((a, i) => a + (i.colaboradores || []).length, 0);
    const partes = String(sol.data_solicitacao || '').split('-');
    const dia = partes.length === 3 ? partes[2] : '—';
    const mes = partes.length === 3 ? MESES[Number(partes[1]) - 1] : '';
    const setor = sol.setor_solicitante || sol.setor || '—';
    const equipamento = sol.equipamento || '';
    const asCode = sol.as_code || '';
    const referencia = equipamento || (asCode.includes(' - ') ? asCode.split(' - ')[0] : asCode) || '—';
    const titulo = `HE ${formatarData(sol.data_solicitacao)} · ${referencia}`;
    const resumo = sol.resumo_texto || montarResumoAdmin(sol);

    const funcoesHtml = itens.length
        ? itens.map(item => `
            <div class="sol-func-item">
                <div class="sol-func-head">
                    <span class="funcao">${escapar((item.funcao || '').toUpperCase())}</span>
                    <span class="qtd">${(item.colaboradores || []).length}</span>
                </div>
                <div class="sol-func-colabs">
                    ${(item.colaboradores || []).map(c => `<span>${escapar(formatarColaborador(c))}</span>`).join('') || '<span>—</span>'}
                </div>
            </div>
        `).join('')
        : '<p class="hint" style="margin-top:12px;">Nenhum item.</p>';

    const detalhesHtml = [
        ['Solicitante', sol.solicitante || '—'],
        ['Setor', setor],
        ['AS', asCode || '—'],
        ['Equipamento', equipamento || '—'],
        ['Data', formatarData(sol.data_solicitacao)],
        ['Turno', turno],
        ['Observação', sol.observacao || '—'],
    ].map(([label, value]) => `
        <div class="row"><dt>${escapar(label)}</dt><dd>${escapar(value)}</dd></div>
    `).join('');

    return `
        <div class="sol-row" data-id="${sol.id}" data-texto="${escAttr(resumo)}" title="${escAttr(titulo)}">
            <div class="sol-row-head">
                <span class="sol-col-data">
                    <span class="dia">${escapar(dia)}</span><span class="mes">${escapar(mes)}</span>
                    <span class="data-completa">${escapar(formatarData(sol.data_solicitacao))}</span>
                    <span class="turno-linha">${escapar(turno)}</span>
                </span>
                <span class="sol-col-solicitante">${escapar(sol.solicitante || '—')}</span>
                <span class="sol-col-setor">${escapar(setor)}</span>
                <span class="sol-col-as">${escapar(asCode || '—')}</span>
                <span class="sol-col-pessoas"><span class="chip-count">${qtd}</span></span>
                <span class="sol-col-acoes">
                    <span class="chip-badge turno ${turnoCss}">${escapar(turno)}</span>
                    <span class="chip-count">${qtd}</span>
                    <button type="button" class="sol-toggle" title="Abrir a ficha" aria-label="Abrir a ficha">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>
                    </button>
                </span>
            </div>
            <div class="sol-row-body" hidden>
                <div class="sol-row-grid">
                    <div class="sol-row-panel">
                        <div class="sol-row-panel-title">Funções</div>
                        ${funcoesHtml}
                    </div>
                    <div class="sol-row-panel">
                        <div class="sol-row-panel-title">Detalhes</div>
                        <dl class="sol-detalhe-list">${detalhesHtml}</dl>
                    </div>
                </div>
                <div class="sol-row-actions">
                    <button type="button" class="btn-secondary btn-copiar-texto">Copiar texto</button>
                    <button type="button" class="btn-secondary btn-editar">Editar</button>
                    <button type="button" class="btn-danger btn-apagar">Apagar</button>
                </div>
                <div class="sol-edit-form" hidden></div>
            </div>
        </div>
    `;
}

function formatarColaborador(c) {
    if (typeof c === 'string') return c;
    if (c.a_procura) return `${c.matricula || '01'} - ${c.descricao || c.nome} (À procura...)`;
    return `${c.matricula || ''} - ${c.nome || ''}`.trim();
}

async function copiarTexto(texto) {
    try {
        await navigator.clipboard.writeText(texto);
    } catch {
        /* silencioso: clipboard indisponível */
    }
}

async function apagarSolicitacao(id) {
    if (!confirm('Apagar esta solicitação? Esta ação fica registrada na auditoria.')) return;
    try {
        const res = await fetch('/api/admin/solicitacoes/' + id, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) {
            alert(data.error || 'Erro ao apagar');
            return;
        }
        await carregar(termoAtual);
    } catch (e) {
        alert('Erro: ' + e.message);
    }
}

function montarResumoAdmin(sol) {
    const data = formatarData(sol.data_solicitacao);
    const ref = sol.equipamento || sol.as_code || '';
    let t = `HE ${data} - ${ref}\n\n`;
    (sol.solicitacao_itens || []).forEach(item => {
        const qtd = String(item.quantidade || 0).padStart(2, '0');
        t += `${(item.funcao || '').toUpperCase()}: ${qtd}\n`;
    });
    if (sol.observacao) {
        t += `\nObservação:\n${sol.observacao}`;
    }
    return t;
}

function formatarData(iso) {
    if (!iso) return '';
    const p = String(iso).split('-');
    if (p.length === 3) return `${p[2]}/${p[1]}/${p[0]}`;
    return iso;
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

/* ==================== Edição de solicitações ==================== */

async function garantirDadosEdicao() {
    if (formConfigCache && funcoesCache && efetivoCache) return;
    if (!dadosEdicaoPromise) {
        dadosEdicaoPromise = Promise.all([
            fetch('/api/formulario').then(r => r.json()),
            fetch('/api/funcoes').then(r => r.json()),
            fetch('/api/efetivo').then(r => r.json()),
        ]).then(([formulario, funcoes, efetivo]) => {
            formConfigCache = formulario;
            funcoesCache = Array.isArray(funcoes) ? funcoes : [];
            efetivoCache = Array.isArray(efetivo) ? efetivo : [];
        }).catch((e) => {
            dadosEdicaoPromise = null;
            throw e;
        });
    }
    return dadosEdicaoPromise;
}

async function alternarEdicao(row, id) {
    const editBox = row.querySelector('.sol-edit-form');
    if (!editBox) return;

    if (edicaoAbertaId === id) {
        editBox.hidden = true;
        editBox.innerHTML = '';
        edicaoAbertaId = null;
        return;
    }

    const sol = solsAtuais.get(id);
    if (!sol) return;

    editBox.hidden = false;
    editBox.innerHTML = '<p class="hint">Carregando formulário...</p>';
    try {
        await garantirDadosEdicao();
        editBox.innerHTML = '';
        editBox.appendChild(montarFormularioEdicao(sol));
        edicaoAbertaId = id;
    } catch (e) {
        editBox.innerHTML = `<p class="hint">Erro ao carregar dados para edição: ${escapar(e.message)}</p>`;
    }
}

function montarFormularioEdicao(sol) {
    const wrap = document.createElement('div');
    wrap.className = 'sol-edit-inner';

    const grid = document.createElement('div');
    grid.className = 'sol-edit-grid';

    const gSolic = document.createElement('div');
    gSolic.className = 'form-group';
    gSolic.innerHTML = '<label>Solicitante</label>';
    gSolic.appendChild(montarComboboxSolicitante(sol.solicitante || ''));
    grid.appendChild(gSolic);

    const gSetor = document.createElement('div');
    gSetor.className = 'form-group';
    gSetor.innerHTML = '<label>Setor Solicitante</label>';
    const selSetor = montarSelectOpcoes('setor_solicitante', sol.setor_solicitante || sol.setor || '');
    selSetor.dataset.campo = 'setor_solicitante';
    gSetor.appendChild(selSetor);
    grid.appendChild(gSetor);

    const gAs = document.createElement('div');
    gAs.className = 'form-group';
    gAs.innerHTML = '<label>AS (Área de Serviço)</label>';
    const selAs = montarSelectOpcoes('as_code', sol.as_code || '');
    selAs.dataset.campo = 'as_code';
    gAs.appendChild(selAs);
    grid.appendChild(gAs);

    const gData = document.createElement('div');
    gData.className = 'form-group';
    gData.innerHTML = '<label>Data da solicitação</label>';
    const inputData = document.createElement('input');
    inputData.type = 'date';
    inputData.dataset.campo = 'data_solicitacao';
    inputData.value = sol.data_solicitacao || '';
    gData.appendChild(inputData);
    grid.appendChild(gData);

    const gTurno = document.createElement('div');
    gTurno.className = 'form-group';
    gTurno.innerHTML = '<label>Turno</label>';
    const radioTurno = montarRadioTurno(sol.turno || 'Dia', sol.id);
    radioTurno.dataset.campo = 'turno';
    gTurno.appendChild(radioTurno);
    grid.appendChild(gTurno);

    wrap.appendChild(grid);

    // Os itens vem todos na mesma tabela; o que separa um equipamento de uma
    // funcao e o nome bater com a lista de equipamentos cadastrada.
    const todos = (sol.solicitacao_itens || []).filter(i => i.funcao);
    const itens = todos.filter(i => !ehEquipamento(i.funcao));
    const itensEquip = todos.filter(i => ehEquipamento(i.funcao));

    const funcTitle = document.createElement('div');
    funcTitle.className = 'sol-edit-secao-titulo';
    funcTitle.textContent = 'Funções e colaboradores';
    wrap.appendChild(funcTitle);

    const blocosContainer = document.createElement('div');
    blocosContainer.className = 'blocos-lista edit-blocos-container';
    wrap.appendChild(blocosContainer);

    if (itens.length) {
        itens.forEach(item => adicionarBlocoEdicao(blocosContainer, item));
    } else {
        adicionarBlocoEdicao(blocosContainer, null);
    }

    const btnAdd = document.createElement('button');
    btnAdd.type = 'button';
    btnAdd.className = 'btn-add';
    btnAdd.textContent = '+ Adicionar função';
    btnAdd.addEventListener('click', () => adicionarBlocoEdicao(blocosContainer, null));
    wrap.appendChild(btnAdd);

    const equipTitle = document.createElement('div');
    equipTitle.className = 'sol-edit-secao-titulo';
    equipTitle.textContent = 'Equipamentos';
    wrap.appendChild(equipTitle);

    const equipContainer = document.createElement('div');
    equipContainer.className = 'blocos-lista edit-equip-container';
    wrap.appendChild(equipContainer);

    itensEquip.forEach(item => adicionarBlocoEquipamentoEdicao(equipContainer, item));

    const btnAddEquip = document.createElement('button');
    btnAddEquip.type = 'button';
    btnAddEquip.className = 'btn-add';
    btnAddEquip.textContent = '+ Adicionar equipamento';
    btnAddEquip.addEventListener('click', () => adicionarBlocoEquipamentoEdicao(equipContainer, null));
    wrap.appendChild(btnAddEquip);

    const gObs = document.createElement('div');
    gObs.className = 'form-group';
    gObs.style.marginTop = '18px';
    gObs.innerHTML = '<label>Observação</label>';
    const textarea = document.createElement('textarea');
    textarea.dataset.campo = 'observacao';
    textarea.rows = 3;
    textarea.value = sol.observacao || '';
    gObs.appendChild(textarea);
    wrap.appendChild(gObs);

    const msgErro = document.createElement('p');
    msgErro.className = 'erro-inline sol-edit-erro';
    msgErro.hidden = true;

    const acoes = document.createElement('div');
    acoes.className = 'sol-edit-actions';
    const btnSalvar = document.createElement('button');
    btnSalvar.type = 'button';
    btnSalvar.className = 'btn-primary';
    btnSalvar.textContent = 'Salvar alterações';
    const btnCancelar = document.createElement('button');
    btnCancelar.type = 'button';
    btnCancelar.className = 'btn-secondary';
    btnCancelar.textContent = 'Cancelar';

    btnCancelar.addEventListener('click', () => alternarEdicao(wrap.closest('.sol-row'), String(sol.id)));
    btnSalvar.addEventListener('click', () => salvarEdicao(sol.id, wrap, btnSalvar, msgErro));

    acoes.appendChild(btnSalvar);
    acoes.appendChild(btnCancelar);
    wrap.appendChild(acoes);
    wrap.appendChild(msgErro);

    return wrap;
}

function montarComboboxSolicitante(valorInicial) {
    const wrap = document.createElement('div');
    wrap.className = 'combobox';
    wrap.dataset.campo = 'solicitante';
    const temValor = !!valorInicial;
    wrap.innerHTML = `
        <input type="search" class="combobox-input" placeholder="Matrícula ou nome" autocomplete="off">
        <input type="hidden" value="${escAttr(valorInicial || '')}">
        <div class="combobox-lista" hidden></div>
        <div class="combobox-selecionado" ${temValor ? '' : 'hidden'}>${temValor ? `<span>${escapar(valorInicial)}</span><button type="button" class="btn-x-mini" title="Limpar">×</button>` : ''}</div>
    `;
    const hidden = wrap.querySelector('input[type="hidden"]');
    const sel = wrap.querySelector('.combobox-selecionado');
    sel.querySelector('.btn-x-mini')?.addEventListener('click', () => {
        hidden.value = '';
        sel.hidden = true;
        sel.innerHTML = '';
    });
    setupCombobox(wrap, efetivoCache || [], (item) => {
        hidden.value = `${item.matricula} - ${item.nome}`;
    }, () => { hidden.value = ''; });
    return wrap;
}

function montarSelectOpcoes(grupo, valorInicial) {
    const select = document.createElement('select');
    select.innerHTML = '<option value=""></option>';
    const opts = (formConfigCache?.opcoes?.[grupo]) || [];
    let encontrado = false;
    opts.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.valor;
        opt.textContent = o.label || o.valor;
        if (o.valor === valorInicial) { opt.selected = true; encontrado = true; }
        select.appendChild(opt);
    });
    if (valorInicial && !encontrado) {
        const opt = document.createElement('option');
        opt.value = valorInicial;
        opt.textContent = valorInicial;
        opt.selected = true;
        select.appendChild(opt);
    }
    // setupSearchSelect precisa que o <select> já tenha um parentNode (usa
    // parentNode.insertBefore); como este elemento ainda não foi inserido no
    // formulário, damos a ele um parent temporário (DocumentFragment) e
    // devolvemos o wrapper .searchable-select gerado, não o <select> puro.
    const frag = document.createDocumentFragment();
    frag.appendChild(select);
    setupSearchSelect(select);
    return select.closest('.searchable-select') || select;
}

function montarRadioTurno(valorInicial, solId) {
    const wrap = document.createElement('div');
    wrap.className = 'radio-group radio-pills';
    const opts = (formConfigCache?.opcoes?.turno) || [];
    const nomeGrupo = `edit-turno-${solId}`;
    opts.forEach(o => {
        const lbl = document.createElement('label');
        lbl.className = 'radio-pill';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = nomeGrupo;
        input.value = o.valor;
        if (o.valor === valorInicial) input.checked = true;
        lbl.appendChild(input);
        lbl.appendChild(document.createTextNode(o.label || o.valor));
        wrap.appendChild(lbl);
    });
    return wrap;
}

function popularSelectFuncao(selectEl, valorInicial) {
    selectEl.innerHTML = '<option value="">Selecione a função</option>';
    let encontrado = false;
    (funcoesCache || []).forEach(f => {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        if (f === valorInicial) { opt.selected = true; encontrado = true; }
        selectEl.appendChild(opt);
    });
    if (valorInicial && !encontrado) {
        const opt = document.createElement('option');
        opt.value = valorInicial;
        opt.textContent = valorInicial;
        opt.selected = true;
        selectEl.appendChild(opt);
    }
    refreshSearchSelect(selectEl);
}

async function carregarColaboradoresEdicao(funcao, container, qtdInput, bloco, selecionados) {
    if (!funcao) {
        container.innerHTML = '';
        atualizarQuantidadeBloco(container, qtdInput, bloco);
        return;
    }
    try {
        const res = await fetch(`/api/colaboradores?funcao=${encodeURIComponent(funcao)}`);
        const dados = await res.json();
        const colaboradores = Array.isArray(dados) ? dados : [];
        // Garante que colaboradores já atribuídos nesta função apareçam mesmo se a
        // grafia da função salva na solicitação não bater (case-sensitive) com a
        // cadastrada hoje no efetivo — evita que a seleção "suma" ao editar.
        const presentes = new Set(colaboradores.map(c => `${c.matricula}|${c.nome}`));
        (selecionados || []).forEach(c => {
            const key = `${c.matricula}|${c.nome}`;
            if (!presentes.has(key)) {
                colaboradores.push({ matricula: c.matricula, nome: c.nome, funcao });
                presentes.add(key);
            }
        });
        const jaSelecionados = new Set((selecionados || []).map(c => `${c.matricula}|${c.nome}`));
        container.innerHTML = '';
        colaboradores.forEach(col => {
            const label = document.createElement('label');
            label.dataset.matricula = (col.matricula || '').toLowerCase();
            label.dataset.nome = (col.nome || '').toLowerCase();
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = col.nome;
            checkbox.dataset.matricula = col.matricula;
            checkbox.dataset.nome = col.nome;
            if (jaSelecionados.has(`${col.matricula}|${col.nome}`)) checkbox.checked = true;
            checkbox.addEventListener('change', () => atualizarQuantidadeBloco(container, qtdInput, bloco));
            label.appendChild(checkbox);

            // A matrícula fica sempre visível: homônimos só se distinguem por ela.
            const matricula = document.createElement('span');
            matricula.className = 'colab-matricula';
            matricula.textContent = col.matricula || '';
            label.appendChild(matricula);

            const nome = document.createElement('span');
            nome.className = 'colab-nome';
            nome.textContent = col.nome || '';
            label.appendChild(nome);

            container.appendChild(label);
        });
        atualizarQuantidadeBloco(container, qtdInput, bloco);
    } catch {
        container.innerHTML = '<span class="erro-inline">Erro ao carregar colaboradores</span>';
    }
}

function atualizarQuantidadeBloco(container, qtdInput, bloco) {
    const checked = container.querySelectorAll('input[type="checkbox"]:checked').length;
    qtdInput.value = checked;
    const caixa = bloco.querySelector('.bloco-item-count');
    if (!caixa) return;
    caixa.classList.toggle('tem-gente', checked > 0);
    const conta = caixa.querySelector('.conta');
    const label = caixa.querySelector('.conta-label');
    if (conta) conta.textContent = checked;
    if (label) label.textContent = checked === 1 ? 'colaborador marcado' : 'colaboradores marcados';
}

function filtrarColaboradoresBlocoEdicao(container, q) {
    const ql = (q || '').trim().toLowerCase();
    container.querySelectorAll('label').forEach(label => {
        if (!ql) { label.style.display = ''; return; }
        const mat = label.dataset.matricula || '';
        const nome = label.dataset.nome || '';
        label.style.display = (mat.includes(ql) || nome.includes(ql)) ? '' : 'none';
    });
}

function adicionarBlocoEdicao(container, itemExistente) {
    const template = document.getElementById('admin-bloco-template');
    const clone = template.content.cloneNode(true);
    const bloco = clone.querySelector('.bloco-funcao');
    const ordem = container.querySelectorAll('.bloco-funcao').length + 1;
    const badge = bloco.querySelector('.bloco-item-badge');
    if (badge) badge.textContent = `Função ${ordem}`;
    const num = bloco.querySelector('.bloco-talao-num');
    if (num) num.textContent = String(ordem).padStart(2, '0');

    const select = bloco.querySelector('.funcao-select');
    const qtdInput = bloco.querySelector('.quantidade-input');
    const divColab = bloco.querySelector('.colaboradores-container');
    const buscaBloco = bloco.querySelector('.busca-colab-bloco');

    popularSelectFuncao(select, itemExistente?.funcao || '');
    setupSearchSelect(select);

    select.addEventListener('change', () => {
        carregarColaboradoresEdicao(select.value, divColab, qtdInput, bloco, null);
    });

    let buscaDebounce = null;
    buscaBloco.addEventListener('input', () => {
        clearTimeout(buscaDebounce);
        buscaDebounce = setTimeout(() => filtrarColaboradoresBlocoEdicao(divColab, buscaBloco.value), 200);
    });

    bloco.querySelector('.btn-remover-bloco').addEventListener('click', () => {
        bloco.remove();
    });

    container.appendChild(bloco);

    if (itemExistente?.funcao) {
        carregarColaboradoresEdicao(itemExistente.funcao, divColab, qtdInput, bloco, itemExistente.colaboradores || []);
    }
    return bloco;
}

/* Um item e equipamento quando o nome consta na lista de equipamentos
   cadastrada — a tabela de itens nao guarda o tipo. */
function ehEquipamento(nome) {
    const lista = (formConfigCache?.opcoes?.equipamento) || [];
    const alvo = String(nome || '').trim().toLowerCase();
    return lista.some(o => String(o.valor || '').trim().toLowerCase() === alvo);
}

function adicionarBlocoEquipamentoEdicao(container, itemExistente) {
    const bloco = document.createElement('div');
    bloco.className = 'bloco-item bloco-equipamento';

    const topo = document.createElement('div');
    topo.className = 'bloco-item-top';
    const badge = document.createElement('span');
    badge.className = 'bloco-item-badge badge-equip';
    badge.textContent = `Equipamento ${container.querySelectorAll('.bloco-equipamento').length + 1}`;
    const btnRemover = document.createElement('button');
    btnRemover.type = 'button';
    btnRemover.className = 'btn-remover-bloco';
    btnRemover.title = 'Remover equipamento';
    btnRemover.setAttribute('aria-label', 'Remover equipamento');
    btnRemover.textContent = '×';
    btnRemover.addEventListener('click', () => {
        bloco.remove();
        renumerarEquipamentosEdicao(container);
    });
    topo.appendChild(badge);
    topo.appendChild(btnRemover);
    bloco.appendChild(topo);

    const corpo = document.createElement('div');
    corpo.className = 'bloco-item-body';
    const grid = document.createElement('div');
    grid.className = 'bloco-grid';

    const gEquip = document.createElement('div');
    gEquip.className = 'form-group';
    gEquip.style.marginBottom = '0';
    gEquip.innerHTML = '<label>Equipamento</label>';
    const selEquip = montarSelectOpcoes('equipamento', itemExistente?.funcao || '');
    selEquip.classList.add('equipamento-select-edicao');
    gEquip.appendChild(selEquip);
    grid.appendChild(gEquip);

    // O operador fica no primeiro colaborador do item.
    const op = (itemExistente?.colaboradores || [])[0];
    const opTexto = op ? `${op.matricula || ''} - ${op.nome || ''}`.trim() : '';
    const gOp = document.createElement('div');
    gOp.className = 'form-group';
    gOp.style.marginBottom = '0';
    gOp.innerHTML = '<label>Operador</label>';
    gOp.appendChild(montarComboboxOperador(opTexto));
    grid.appendChild(gOp);

    corpo.appendChild(grid);
    bloco.appendChild(corpo);
    container.appendChild(bloco);
    renumerarEquipamentosEdicao(container);
    return bloco;
}

function renumerarEquipamentosEdicao(container) {
    container.querySelectorAll('.bloco-equipamento').forEach((bloco, i) => {
        const badge = bloco.querySelector('.bloco-item-badge');
        if (badge) badge.textContent = `Equipamento ${i + 1}`;
    });
}

function montarComboboxOperador(valorInicial) {
    const wrap = document.createElement('div');
    wrap.className = 'combobox';
    wrap.dataset.campo = 'operador';
    const temValor = !!valorInicial;
    wrap.innerHTML = `
        <input type="search" class="combobox-input" placeholder="Matrícula ou nome" autocomplete="off">
        <input type="hidden" value="${escAttr(valorInicial || '')}">
        <div class="combobox-lista" hidden></div>
        <div class="combobox-selecionado" ${temValor ? '' : 'hidden'}>${temValor ? `<span>${escapar(valorInicial)}</span><button type="button" class="btn-x-mini" title="Limpar">×</button>` : ''}</div>
    `;
    const hidden = wrap.querySelector('input[type="hidden"]');
    const sel = wrap.querySelector('.combobox-selecionado');
    sel.querySelector('.btn-x-mini')?.addEventListener('click', () => {
        hidden.value = '';
        sel.hidden = true;
        sel.innerHTML = '';
    });
    setupCombobox(wrap, efetivoCache || [], (item) => {
        hidden.value = `${item.matricula} - ${item.nome}`;
    }, () => { hidden.value = ''; });
    return wrap;
}

function coletarDadosEdicao(formWrap) {
    const solicitante = formWrap.querySelector('[data-campo="solicitante"] input[type="hidden"]')?.value || '';
    const setor_solicitante = formWrap.querySelector('[data-campo="setor_solicitante"] select')?.value || '';
    const as_code = formWrap.querySelector('[data-campo="as_code"] select')?.value || '';
    const data_solicitacao = formWrap.querySelector('[data-campo="data_solicitacao"]')?.value || '';
    const turno = formWrap.querySelector('[data-campo="turno"] input:checked')?.value || 'Dia';
    const observacao = formWrap.querySelector('[data-campo="observacao"]')?.value || '';

    const itens = [];
    formWrap.querySelectorAll('.edit-blocos-container .bloco-funcao').forEach(bloco => {
        const funcao = bloco.querySelector('.funcao-select')?.value;
        if (!funcao) return;
        const checkboxes = bloco.querySelectorAll('.colaboradores-container input:checked');
        const colaboradores = Array.from(checkboxes).map(cb => ({
            matricula: cb.dataset.matricula,
            nome: cb.dataset.nome || cb.value,
            a_procura: false,
        }));
        if (!colaboradores.length) return;
        const quantidade = parseInt(bloco.querySelector('.quantidade-input')?.value, 10) || colaboradores.length;
        itens.push({ funcao, quantidade, colaboradores, tipo: 'funcao' });
    });

    const equipamentos = [];
    formWrap.querySelectorAll('.edit-equip-container .bloco-equipamento').forEach(bloco => {
        const nome = bloco.querySelector('select')?.value;
        if (!nome) return;
        const texto = bloco.querySelector('[data-campo="operador"] input[type="hidden"]')?.value || '';
        const partes = texto.split(' - ');
        const operador = texto
            ? { matricula: partes[0]?.trim(), nome: partes.slice(1).join(' - ').trim() || texto, a_procura: false }
            : null;
        equipamentos.push({ equipamento: nome, operador });
    });

    // O campo legado no cabecalho passa a ser o primeiro equipamento da lista.
    const equipamento = equipamentos.length ? equipamentos[0].equipamento : '';

    return { solicitante, setor_solicitante, equipamento, as_code, data_solicitacao, turno, observacao, itens, equipamentos };
}

async function salvarEdicao(id, formWrap, btnSalvar, msgErro) {
    msgErro.hidden = true;
    const payload = coletarDadosEdicao(formWrap);
    if (!payload.solicitante) {
        msgErro.hidden = false;
        msgErro.textContent = 'Informe o solicitante.';
        return;
    }
    if (!payload.data_solicitacao) {
        msgErro.hidden = false;
        msgErro.textContent = 'Informe a data da solicitação.';
        return;
    }
    if (!payload.itens.length) {
        msgErro.hidden = false;
        msgErro.textContent = 'Adicione ao menos uma função com colaboradores.';
        return;
    }
    btnSalvar.disabled = true;
    btnSalvar.textContent = 'Salvando...';
    try {
        const res = await fetch('/api/admin/solicitacoes/' + id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
            msgErro.hidden = false;
            msgErro.textContent = data.error || 'Erro ao salvar';
            btnSalvar.disabled = false;
            btnSalvar.textContent = 'Salvar alterações';
            return;
        }
        await carregar(termoAtual);
    } catch (e) {
        msgErro.hidden = false;
        msgErro.textContent = 'Erro de comunicação: ' + e.message;
        btnSalvar.disabled = false;
        btnSalvar.textContent = 'Salvar alterações';
    }
}

/* ---------- Combobox / select pesquisável (copiado de script.js) ---------- */

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

function setupCombobox(wrap, listaFonte, onSelect, onClear) {
    const input = wrap.querySelector('input[type="search"], .combobox-input');
    const hidden = wrap.querySelector('input[type="hidden"]');
    const lista = wrap.querySelector('.combobox-lista');
    const sel = wrap.querySelector('.combobox-selecionado');
    let fonte = listaFonte;

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
                if (onSelect) onSelect(item);
            });
        });
    }

    input.addEventListener('focus', () => renderLista(input.value));
    input.addEventListener('input', () => renderLista(input.value));
    input.addEventListener('blur', () => setTimeout(() => { lista.hidden = true; }, 150));
}
