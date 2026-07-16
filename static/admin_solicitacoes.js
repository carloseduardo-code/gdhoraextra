let debounce = null;
let termoAtual = '';

document.addEventListener('DOMContentLoaded', () => {
    carregar('');
    const busca = document.getElementById('busca');
    busca.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => carregar(busca.value.trim()), 250);
    });
    document.getElementById('btn-exportar').addEventListener('click', exportar);
});

async function carregar(q) {
    termoAtual = q || '';
    const box = document.getElementById('lista-solicitacoes');
    box.innerHTML = '<p>Carregando...</p>';
    try {
        const res = await fetch('/api/admin/solicitacoes?q=' + encodeURIComponent(termoAtual));
        const dados = await res.json();
        if (!res.ok) throw new Error(dados.error || 'Erro');
        if (!dados.length) {
            box.innerHTML = '<p>Nenhuma solicitação encontrada.</p>';
            return;
        }
        box.innerHTML = '';
        dados.forEach(sol => {
            const card = document.createElement('div');
            card.className = 'sol-card';
            const resumo = sol.resumo_admin || montarResumoAdmin(sol);
            const detalhesId = 'det-' + sol.id;
            card.innerHTML = `
                <pre class="resumo-admin">${escapar(resumo)}</pre>
                <div class="sol-meta">
                    <span>${escapar(sol.solicitante || '—')}</span>
                    <span>${escapar(sol.setor_solicitante || sol.setor || '')}</span>
                    <span>${escapar(sol.turno || '')}</span>
                </div>
                <div class="sol-acoes">
                    <button type="button" class="btn-secondary btn-detalhe" data-target="${detalhesId}">Ver detalhes</button>
                    <button type="button" class="btn-danger btn-apagar" data-id="${sol.id}">Apagar</button>
                </div>
                <div id="${detalhesId}" class="sol-detalhe" hidden></div>
            `;
            const detalhe = card.querySelector('.sol-detalhe');
            detalhe.innerHTML = montarDetalhe(sol);
            card.querySelector('.btn-detalhe').addEventListener('click', (ev) => {
                const el = document.getElementById(ev.target.dataset.target);
                el.hidden = !el.hidden;
                ev.target.textContent = el.hidden ? 'Ver detalhes' : 'Ocultar detalhes';
            });
            card.querySelector('.btn-apagar').addEventListener('click', () => apagarSolicitacao(sol.id));
            box.appendChild(card);
        });
    } catch (e) {
        box.innerHTML = `<p>Erro: ${escapar(e.message)}</p>`;
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

function montarDetalhe(sol) {
    let html = `<p><strong>Solicitante:</strong> ${escapar(sol.solicitante || '—')}<br>
        <strong>Setor:</strong> ${escapar(sol.setor_solicitante || sol.setor || '—')}<br>
        <strong>Equipamento:</strong> ${escapar(sol.equipamento || '—')}<br>
        <strong>AS:</strong> ${escapar(sol.as_code || '—')}<br>
        <strong>Data:</strong> ${escapar(formatarData(sol.data_solicitacao))}<br>
        <strong>Turno:</strong> ${escapar(sol.turno || '—')}</p>`;
    (sol.solicitacao_itens || []).forEach(item => {
        html += `<h3>${escapar(item.funcao)} (${item.quantidade})</h3><ul>`;
        (item.colaboradores || []).forEach(c => {
            if (typeof c === 'string') {
                html += `<li>${escapar(c)}</li>`;
            } else if (c.a_procura) {
                html += `<li>${escapar(c.matricula || '01')} - ${escapar(c.descricao || c.nome)} (À procura...)</li>`;
            } else {
                html += `<li>${escapar(c.matricula || '')} - ${escapar(c.nome || '')}</li>`;
            }
        });
        html += '</ul>';
    });
    if (sol.resumo_texto) {
        html += `<details><summary>Texto completo (WhatsApp)</summary><pre class="resumo-box">${escapar(sol.resumo_texto)}</pre></details>`;
    }
    return html;
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

async function exportar() {
    try {
        const res = await fetch('/api/admin/exportar');
        const data = await res.json();
        if (!res.ok || !data.excel_base64) {
            alert(data.error || 'Erro ao exportar');
            return;
        }
        const link = document.createElement('a');
        link.href = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + data.excel_base64;
        link.download = data.filename || 'solicitacoes.xlsx';
        link.click();
    } catch {
        alert('Erro na exportação.');
    }
}
