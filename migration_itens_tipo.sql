-- Execute no SQL Editor do Supabase (Dashboard → SQL Editor)
-- Guarda o tipo do item da solicitação (função x equipamento).
--
-- Sem estas colunas o equipamento volta do banco como se fosse uma função:
-- some da coluna "Equipamento" da exportação e entra na contagem de funções
-- do painel. A aplicação funciona antes e depois desta migração — mas só
-- depois dela o tipo sobrevive à gravação.

alter table public.solicitacao_itens add column if not exists tipo text not null default 'funcao';
alter table public.solicitacao_itens add column if not exists equipamento text;

-- Reclassifica os itens já gravados: é equipamento quando o nome do item
-- consta na lista de equipamentos cadastrada.
update public.solicitacao_itens i
set tipo = 'equipamento',
    equipamento = i.funcao
where i.tipo = 'funcao'
  and exists (
    select 1 from public.form_opcoes o
    where o.grupo = 'equipamento'
      and upper(trim(o.valor)) = upper(trim(i.funcao))
  );
