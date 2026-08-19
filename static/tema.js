/* Alternância de tema dia/noite.
   O tema já foi aplicado em _head.html antes da primeira pintura; aqui só
   ficam a troca manual e a sincronização dos botões. */
(function () {
    'use strict';

    const RAIZ = document.documentElement;
    const CHAVE = 'he-tema';

    function atual() {
        return RAIZ.getAttribute('data-tema') === 'noite' ? 'noite' : 'dia';
    }

    function sincronizar() {
        const noite = atual() === 'noite';
        const rotulo = noite ? 'Mudar para o tema dia' : 'Mudar para o tema noite';
        document.querySelectorAll('[data-tema-toggle]').forEach(btn => {
            btn.setAttribute('aria-label', rotulo);
            btn.setAttribute('title', rotulo);
            btn.setAttribute('aria-pressed', noite ? 'true' : 'false');
            const texto = btn.querySelector('[data-tema-texto]');
            if (texto) texto.textContent = noite ? 'Dia' : 'Noite';
        });
        const meta = document.querySelector('meta[name="theme-color"]:not([media])');
        if (meta) meta.setAttribute('content', noite ? '#121815' : '#E8E9E5');
    }

    function trocar() {
        const proximo = atual() === 'noite' ? 'dia' : 'noite';
        RAIZ.setAttribute('data-tema', proximo);
        try { localStorage.setItem(CHAVE, proximo); } catch (e) { /* sem persistência */ }
        sincronizar();
    }

    document.addEventListener('click', function (e) {
        const btn = e.target.closest && e.target.closest('[data-tema-toggle]');
        if (!btn) return;
        e.preventDefault();
        trocar();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', sincronizar);
    } else {
        sincronizar();
    }
})();
