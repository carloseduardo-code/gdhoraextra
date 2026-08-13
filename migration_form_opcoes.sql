-- Execute no SQL Editor do Supabase (Dashboard → SQL Editor)
-- Migração idempotente: segura para rodar mais de uma vez.
--
-- O que corrige:
-- 1) Colunas que faltam em "solicitacoes" (solicitante, setor_solicitante, equipamento,
--    observacao, resumo_texto, resumo_admin) — sem elas, o app grava a solicitação sem
--    esses campos, e é por isso que "Solicitante" aparece vazio no admin.
-- 2) Tabela "form_opcoes" (Equipamento/Setor/AS/Turno) — o app vai passar a gravar as
--    opções de configuração aqui em vez de um arquivo local (que não pode ser escrito
--    em produção na Vercel, por isso criar/editar opção não funcionava).
-- 3) Preenche "form_opcoes" com os valores que estão em uso hoje em produção
--    (equivalente ao data/opcoes.json atual do repositório), substituindo qualquer
--    conteúdo antigo/parcial que já exista nesses grupos.

-- ========== 1) COLUNAS FALTANTES EM SOLICITACOES ==========
alter table public.solicitacoes add column if not exists solicitante text;
alter table public.solicitacoes add column if not exists setor_solicitante text;
alter table public.solicitacoes add column if not exists equipamento text;
alter table public.solicitacoes add column if not exists observacao text;
alter table public.solicitacoes add column if not exists resumo_texto text;
alter table public.solicitacoes add column if not exists resumo_admin text;

-- ========== 2) TABELA FORM_OPCOES ==========
create table if not exists public.form_opcoes (
  id bigserial primary key,
  grupo text not null,
  valor text not null,
  label text,
  ordem integer not null default 0,
  ativo boolean not null default true,
  unique (grupo, valor)
);

alter table public.form_opcoes enable row level security;

drop policy if exists "form_opcoes_all" on public.form_opcoes;
create policy "form_opcoes_all" on public.form_opcoes for all to anon, authenticated using (true) with check (true);

-- (garante também que form_campos existe, caso ainda não exista)
create table if not exists public.form_campos (
  id bigserial primary key,
  chave text not null unique,
  label text not null,
  tipo text not null check (tipo in ('text', 'select', 'date', 'radio', 'funcoes')),
  obrigatorio boolean not null default true,
  ordem integer not null default 0,
  ativo boolean not null default true,
  lista_grupo text
);
alter table public.form_campos enable row level security;
drop policy if exists "form_campos_all" on public.form_campos;
create policy "form_campos_all" on public.form_campos for all to anon, authenticated using (true) with check (true);

insert into public.form_campos (chave, label, tipo, obrigatorio, ordem, lista_grupo)
values
  ('solicitante', 'Solicitante', 'text', true, 10, null),
  ('setor_solicitante', 'Setor Solicitante', 'select', true, 20, 'setor_solicitante'),
  ('equipamento', 'Equipamento', 'select', false, 30, 'equipamento'),
  ('as_code', 'AS (Área de Serviço)', 'select', true, 40, 'as_code'),
  ('data_solicitacao', 'Data da solicitação', 'date', true, 50, null),
  ('turno', 'Turno', 'radio', true, 60, 'turno'),
  ('funcoes', 'Funções e Colaboradores', 'funcoes', true, 70, null)
on conflict (chave) do nothing;

-- ========== 3) SUBSTITUI AS OPÇÕES PELOS VALORES ATUAIS DE PRODUÇÃO ==========
-- Remove qualquer conteúdo antigo desses 4 grupos antes de reinserir, pra garantir
-- que a tabela fique exatamente igual ao que está em uso hoje (nada duplicado,
-- nada desatualizado).
delete from public.form_opcoes where grupo in ('equipamento', 'setor_solicitante', 'as_code', 'turno');

insert into public.form_opcoes (grupo, valor, label, ordem) values
  ('setor_solicitante', 'QUALIDADE', 'QUALIDADE', 1),
  ('setor_solicitante', 'SEGURANÇA', 'SEGURANÇA', 2),
  ('setor_solicitante', 'TRANSPORTE', 'TRANSPORTE', 3),
  ('setor_solicitante', 'PLANEJAMENTO', 'PLANEJAMENTO', 4),
  ('setor_solicitante', 'ALMOXERIFADO', 'ALMOXERIFADO', 5),
  ('setor_solicitante', 'MEIO AMBIENTE', 'MEIO AMBIENTE', 6),
  ('setor_solicitante', 'SAUDE', 'SAUDE', 7),
  ('setor_solicitante', 'PRODUÇÃO', 'PRODUÇÃO', 8),
  ('setor_solicitante', 'RH', 'RH', 9),
  ('setor_solicitante', 'MEDIÇÃO', 'MEDIÇÃO', 10),

  ('equipamento', 'TRATOR DE ESTEIRA', 'TRATOR DE ESTEIRA', 1),
  ('equipamento', 'MINI CARREGADEIRA', 'MINI CARREGADEIRA', 2),
  ('equipamento', 'MINI ROLO', 'MINI ROLO', 3),
  ('equipamento', 'MINI ESCAVADEIRA', 'MINI ESCAVADEIRA', 4),
  ('equipamento', 'MINI ESCAVADEIRA C/ROMPEDOR', 'MINI ESCAVADEIRA C/ROMPEDOR', 5),
  ('equipamento', 'MOTO NIVELADORA', 'MOTO NIVELADORA', 6),
  ('equipamento', 'CAMINHÃO PIPA BRUTA', 'CAMINHÃO PIPA BRUTA', 7),
  ('equipamento', 'CAMINHÃO PIPA POTAVEL', 'CAMINHÃO PIPA POTAVEL', 8),
  ('equipamento', 'CAMINHÃO BASCULANTE', 'CAMINHÃO BASCULANTE', 9),
  ('equipamento', 'CAMINHÃO MUNK', 'CAMINHÃO MUNK', 10),
  ('equipamento', 'CAMINHÃO 3/4', 'CAMINHÃO 3/4', 11),
  ('equipamento', 'ESCAVADEIRA', 'ESCAVADEIRA', 12),
  ('equipamento', 'VEICULO PASSAGEIRO', 'VEICULO PASSAGEIRO', 13),
  ('equipamento', 'ONIBUS', 'ONIBUS', 14),
  ('equipamento', 'CAMINHONETE', 'CAMINHONETE', 15),

  ('as_code', 'AS_005 - EQUIPE ADMINISTRATIVA', 'AS_005 - EQUIPE ADMINISTRATIVA', 1),
  ('as_code', 'AS_006 - APOIO A PRODUÇÃO', 'AS_006 - APOIO A PRODUÇÃO', 2),
  ('as_code', 'AS_015-BRITAGEM SECUNDARIA', 'AS_015-BRITAGEM SECUNDARIA', 3),
  ('as_code', 'AS_017-TR-2012KS-11/TR-2036KS-23', 'AS_017-TR-2012KS-11/TR-2036KS-23', 4),
  ('as_code', 'AS_018-CT-2020KS-04', 'AS_018-CT-2020KS-04', 5),
  ('as_code', 'AS_020 - SERVIÇOS EXTRAORDINARIOS', 'AS_020 - SERVIÇOS EXTRAORDINARIOS', 6),
  ('as_code', 'AS_021-TR-2091KS-01/02/03', 'AS_021-TR-2091KS-01/02/03', 7),
  ('as_code', 'AS_022-ARMAÇÃO - CORTE E DOBRA', 'AS_022-ARMAÇÃO - CORTE E DOBRA', 8),
  ('as_code', 'AS_023-ED-2012KS-01', 'AS_023-ED-2012KS-01', 9),
  ('as_code', 'AS_024-APOIO OPERACIONAL', 'AS_024-APOIO OPERACIONAL', 10),
  ('as_code', 'AS_025-TR-2011KS-15', 'AS_025-TR-2011KS-15', 11),
  ('as_code', 'AS_027_TR-2012KS-11', 'AS_027_TR-2012KS-11', 12),
  ('as_code', 'AS_028- SE-2012KS-01 / YY-2012KS-101', 'AS_028- SE-2012KS-01 / YY-2012KS-101', 13),
  ('as_code', 'AS-029- TR-2020KS-03', 'AS-029- TR-2020KS-03', 14),
  ('as_code', 'Outros', 'Outros', 15),

  ('turno', 'Dia', 'Dia', 1),
  ('turno', 'Noite', 'Noite', 2),
  ('turno', 'Extensão de Horário', 'Extensão de Horário', 3);
