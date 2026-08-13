async function exportarExcel() {
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
