const LABELS = {
    equipamento: 'Equipamento',
    setor_solicitante: 'Setor',
    as_code: 'AS',
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
    box.innerHTML = '<p>Carregando...</p>';
    try {
        const res = await fetch('/api/admin/config/opcoes?grupo=' + encodeURIComponent(grupoAtual));
        const dados = await res.json();
        if (!res.ok) throw new Error(dados.error || 'Erro ao carregar');

        if (!dados.length) {
            box.innerHTML = '<p>Nenhuma opção cadastrada. Adicione abaixo.</p>';
            return;
        }

        box.innerHTML = `<table class="data-table">
            <thead><tr><th style="width:70%">Opção</th><th></th></tr></thead>
            <tbody>${dados.map(o => `
                <tr data-id="${o.id}">
                    <td><input type="text" class="inp-valor" value="${escAttr(o.valor)}"></td>
                    <td class="td-acoes">
                        <button type="button" class="btn-secondary btn-salvar-opcao">Salvar</button>
                        <button type="button" class="btn-secondary btn-remover-opcao">Remover</button>
                    </td>
                </tr>
            `).join('')}</tbody>
        </table>`;

        box.querySelectorAll('.btn-salvar-opcao').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tr = btn.closest('tr');
                const valor = tr.querySelector('.inp-valor').value.trim();
                if (!valor) {
                    alert('Informe um valor');
                    return;
                }
                const res = await fetch('/api/admin/config/opcoes/' + tr.dataset.id, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ grupo: grupoAtual, valor }),
                });
                const data = await res.json();
                if (!res.ok) alert(data.error || 'Erro');
                else {
                    statusMsg('Salvo.');
                    await carregarOpcoes();
                }
            });
        });

        box.querySelectorAll('.btn-remover-opcao').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Remover esta opção?')) return;
                const id = btn.closest('tr').dataset.id;
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
        box.innerHTML = `<p class="form-erro">Erro: ${esc(e.message)}</p>`;
    }
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
function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
}
