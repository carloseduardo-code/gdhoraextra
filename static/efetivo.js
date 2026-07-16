let todos = [];
let debounce = null;

document.addEventListener('DOMContentLoaded', () => {
    carregarEfetivo();

    document.getElementById('busca').addEventListener('input', (e) => {
        clearTimeout(debounce);
        debounce = setTimeout(() => renderTabela(e.target.value.trim()), 200);
    });

    document.getElementById('form-importar').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fileInput = document.getElementById('arquivo-input');
        const file = fileInput.files[0];
        if (!file) {
            exibirStatus('Selecione um arquivo primeiro.', 'erro');
            return;
        }
        const formData = new FormData();
        formData.append('arquivo', file);
        const btn = document.getElementById('btn-importar');
        btn.disabled = true;
        btn.textContent = 'Importando...';
        try {
            const res = await fetch('/api/efetivo/importar', { method: 'POST', body: formData });
            const data = await res.json();
            if (res.ok) {
                exibirStatus(data.message, 'sucesso');
                fileInput.value = '';
                await carregarEfetivo();
            } else {
                exibirStatus(data.error || 'Erro', 'erro');
            }
        } catch (err) {
            exibirStatus('Erro: ' + err.message, 'erro');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Importar Planilha';
        }
    });
});

async function carregarEfetivo() {
    const tbody = document.getElementById('efetivo-body');
    tbody.innerHTML = '<tr><td colspan="3">Carregando...</td></tr>';
    try {
        const res = await fetch('/api/efetivo');
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error(data.error || 'Dados inválidos');
        todos = data;
        renderTabela(document.getElementById('busca').value.trim());
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="3">Erro: ${err.message}</td></tr>`;
    }
}

function renderTabela(q) {
    const tbody = document.getElementById('efetivo-body');
    const totalSpan = document.getElementById('total-registros');
    const ql = (q || '').toLowerCase();
    const filtrados = !ql ? todos : todos.filter(r =>
        (r.matricula || '').toLowerCase().includes(ql) ||
        (r.nome || '').toLowerCase().includes(ql) ||
        (r.funcao || '').toLowerCase().includes(ql)
    );
    totalSpan.textContent = `Total: ${filtrados.length}` + (ql ? ` (de ${todos.length})` : '');
    if (!filtrados.length) {
        tbody.innerHTML = '<tr><td colspan="3">Nenhum colaborador encontrado.</td></tr>';
        return;
    }
    tbody.innerHTML = filtrados.map(row => `
        <tr>
            <td>${esc(row.matricula)}</td>
            <td>${esc(row.nome)}</td>
            <td>${esc(row.funcao)}</td>
        </tr>
    `).join('');
}

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function exibirStatus(mensagem, tipo) {
    const span = document.getElementById('status-import');
    span.textContent = mensagem;
    span.className = 'status-msg ' + (tipo || '');
}
