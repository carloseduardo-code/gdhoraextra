let debounce = null;
let termoAtual = '';

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const TURNO_CSS = { 'Dia': 't-dia', 'Noite': 't-noite', 'Extensão de Horário': 't-ext' };

document.addEventListener('DOMContentLoaded', () => {
    carregar('');
    const busca = document.getElementById('busca');
    busca.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => carregar(busca.value.trim()), 250);
    });
    document.getElementById('btn-exportar').addEventListener('click', exportarExcel);
});

async function carregar(q) {
    termoAtual = q || '';
    const box = document.getElementById('lista-solicitacoes');
    const countLabel = document.getElementById('sol-count-label');
    box.innerHTML = '<p class="hint">Carregando...</p>';
    try {
        const res = await fetch('/api/admin/solicitacoes?q=' + encodeURIComponent(termoAtual));
        const dados = await res.json();
        if (!res.ok) throw new Error(dados.error || 'Erro');

        if (countLabel) countLabel.textContent = `${dados.length} registro${dados.length === 1 ? '' : 's'}`;

        if (!dados.length) {
            box.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-title">Nenhuma solicitação encontrada</div>
                    <div class="empty-state-hint">Ajuste a busca para ver outros resultados.</div>
                </div>`;
            return;
        }
        box.innerHTML = dados.map(criarLinha).join('');

        box.querySelectorAll('.sol-row').forEach(row => {
            const id = row.dataset.id;
            const toggle = row.querySelector('.sol-toggle');
            const body = row.querySelector('.sol-row-body');
            toggle.addEventListener('click', () => {
                const abrir = body.hidden;
                body.hidden = !abrir;
                toggle.classList.toggle('open', abrir);
            });
            row.querySelector('.btn-copiar-texto')?.addEventListener('click', () => copiarTexto(row.dataset.texto || ''));
            row.querySelector('.btn-apagar')?.addEventListener('click', () => apagarSolicitacao(id));
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
    ].map(([label, value]) => `
        <div class="row"><dt>${escapar(label)}</dt><dd>${escapar(value)}</dd></div>
    `).join('');

    return `
        <div class="sol-row" data-id="${sol.id}" data-texto="${escAttr(resumo)}">
            <div class="sol-row-head">
                <div class="sol-date-chip"><span class="dia">${escapar(dia)}</span><span class="mes">${escapar(mes)}</span></div>
                <div class="sol-row-title">
                    <div class="titulo">${escapar(titulo)}</div>
                    <div class="sol-row-meta">
                        <span>${escapar(sol.solicitante || '—')}</span><span class="sep">·</span><span>${escapar(setor)}</span><span class="sep">·</span><span>${escapar(asCode || '—')}</span>
                    </div>
                </div>
                <div class="sol-row-side">
                    <span class="chip-badge turno ${turnoCss}">${escapar(turno)}</span>
                    <span class="chip-count">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path><circle cx="9.5" cy="7" r="3.5"></circle><path d="M21 20v-2a4 4 0 0 0-3-3.87"></path></svg>${qtd}
                    </span>
                    <button type="button" class="sol-toggle" title="Detalhes">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>
                    </button>
                </div>
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
                    <button type="button" class="btn-danger btn-apagar">Apagar</button>
                </div>
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
