const LABELS = {
    equipamento: 'Equipamento',
    setor_solicitante: 'Setor solicitante',
    as_code: 'AS — Área de serviço',
};

let grupoAtual = 'equipamento';

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.config-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.config-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            grupoAtual = btn.dataset.grupo;
            document.getElementById('titulo-grupo').textContent = LABELS[grupoAtual] || grupoAtual;
            carregarOpcoes();
        });
    });
    document.getElementById('form-nova-opcao').addEventListener('submit', criarOpcao);
    carregarOpcoes();
});

async function carregarOpcoes() {
    const box = document.getElementById('lista-opcoes');
    box.innerHTML = '<p class="hint" style="padding:16px 18px;margin:0;">Carregando...</p>';
    try {
        const res = await fetch('/api/admin/config/opcoes');
        const todos = await res.json();
        if (!res.ok) throw new Error(todos.error || 'Erro ao carregar');

        Object.keys(LABELS).forEach(g => {
            const pill = document.querySelector(`[data-count-for="${g}"]`);
            if (pill) pill.textContent = (todos[g] || []).length;
        });

        const dados = todos[grupoAtual] || [];
        if (!dados.length) {
            box.innerHTML = '<p class="hint" style="padding:16px 18px;margin:0;">Nenhuma opção cadastrada. Adicione acima.</p>';
            return;
        }

        box.innerHTML = dados.map(o => `
            <div class="config-item-row" data-id="${o.id}" data-valor="${escapar(o.valor)}">
                <span class="config-item-value">${escapar(o.valor)}</span>
                <button type="button" class="btn-icon btn-editar-opcao" title="Editar">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
                </button>
                <button type="button" class="btn-icon btn-remover-opcao" title="Remover">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        `).join('');

        box.querySelectorAll('.btn-editar-opcao').forEach(btn => {
            btn.addEventListener('click', () => iniciarEdicaoOpcao(btn.closest('.config-item-row')));
        });

        box.querySelectorAll('.btn-remover-opcao').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Remover esta opção?')) return;
                const id = btn.closest('.config-item-row').dataset.id;
                const res = await fetch(
                    '/api/admin/config/opcoes/' + id + '?grupo=' + encodeURIComponent(grupoAtual),
                    { method: 'DELETE' }
                );
                const data = await res.json();
                if (!res.ok) alert(data.error || 'Erro');
                else {
                    statusMsg('Removido.');
                    await carregarOpcoes();
                }
            });
        });
    } catch (e) {
        box.innerHTML = `<p class="hint" style="padding:16px 18px;margin:0;">Erro: ${esc(e.message)}</p>`;
    }
}

function iniciarEdicaoOpcao(row) {
    if (!row || row.classList.contains('editando')) return;
    row.classList.add('editando');
    const valorAtual = row.dataset.valor || '';
    row.innerHTML = `
        <input type="text" class="config-item-edit-input" value="${escapar(valorAtual)}" aria-label="Editar opção">
        <button type="button" class="btn-icon btn-salvar-opcao" title="Salvar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
        </button>
        <button type="button" class="btn-icon btn-cancelar-opcao" title="Cancelar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
        </button>
    `;
    const input = row.querySelector('.config-item-edit-input');
    input.focus();
    input.select();

    const salvar = () => salvarEdicaoOpcao(row, input.value.trim());
    row.querySelector('.btn-salvar-opcao').addEventListener('click', salvar);
    row.querySelector('.btn-cancelar-opcao').addEventListener('click', () => carregarOpcoes());
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); salvar(); }
        if (ev.key === 'Escape') carregarOpcoes();
    });
}

async function salvarEdicaoOpcao(row, novoValor) {
    if (!novoValor) {
        alert('Informe o valor da opção');
        return;
    }
    const id = row.dataset.id;
    const res = await fetch('/api/admin/config/opcoes/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grupo: grupoAtual, valor: novoValor }),
    });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || 'Erro ao salvar');
        return;
    }
    statusMsg('Atualizado.');
    await carregarOpcoes();
}

async function criarOpcao(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const valor = (fd.get('valor') || '').trim();
    if (!valor) return;

    const res = await fetch('/api/admin/config/opcoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grupo: grupoAtual, valor }),
    });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || 'Erro');
        return;
    }
    e.target.reset();
    statusMsg('Adicionado.');
    await carregarOpcoes();
}

function statusMsg(texto) {
    const el = document.getElementById('config-status');
    el.hidden = false;
    el.textContent = texto;
    setTimeout(() => { el.hidden = true; }, 2000);
}

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function escapar(s) {
    return esc(s).replace(/"/g, '&quot;');
}
