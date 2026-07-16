-- Execute no SQL Editor do Supabase (Dashboard → SQL Editor)
-- Atualização completa do schema (idempotente)

-- ========== EFETIVO ==========
create table if not exists public.funcionarios (
  matricula text primary key,
  nome text not null,
  funcao text not null
);

-- ========== SOLICITAÇÕES ==========
create table if not exists public.solicitacoes (
  id bigserial primary key,
  solicitante text,
  setor text,
  setor_solicitante text,
  equipamento text,
  as_code text,
  data_solicitacao date not null,
  turno text,
  resumo_texto text,
  resumo_admin text,
  criado_em timestamptz not null default now()
);

alter table public.solicitacoes add column if not exists solicitante text;
alter table public.solicitacoes add column if not exists setor_solicitante text;
alter table public.solicitacoes add column if not exists equipamento text;
alter table public.solicitacoes add column if not exists resumo_texto text;
alter table public.solicitacoes add column if not exists resumo_admin text;

create table if not exists public.solicitacao_itens (
  id bigserial primary key,
  solicitacao_id bigint not null references public.solicitacoes(id) on delete cascade,
  funcao text not null,
  quantidade integer not null default 0,
  colaboradores jsonb not null default '[]'::jsonb
);

-- ========== USUÁRIOS E AUDITORIA ==========
create table if not exists public.usuarios (
  id bigserial primary key,
  usuario text not null unique,
  senha_hash text not null,
  nome text not null,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

create table if not exists public.auditoria (
  id bigserial primary key,
  usuario_id bigint,
  usuario_nome text not null,
  acao text not null,
  entidade text not null,
  entidade_id text,
  detalhes jsonb,
  criado_em timestamptz not null default now()
);

-- ========== CONFIGURAÇÃO DO FORMULÁRIO ==========
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

create table if not exists public.form_opcoes (
  id bigserial primary key,
  grupo text not null,
  valor text not null,
  label text,
  ordem integer not null default 0,
  ativo boolean not null default true,
  unique (grupo, valor)
);

-- ========== RLS ==========
alter table public.funcionarios enable row level security;
alter table public.solicitacoes enable row level security;
alter table public.solicitacao_itens enable row level security;
alter table public.usuarios enable row level security;
alter table public.auditoria enable row level security;
alter table public.form_campos enable row level security;
alter table public.form_opcoes enable row level security;

drop policy if exists "funcionarios_all" on public.funcionarios;
drop policy if exists "solicitacoes_all" on public.solicitacoes;
drop policy if exists "solicitacao_itens_all" on public.solicitacao_itens;
drop policy if exists "usuarios_all" on public.usuarios;
drop policy if exists "auditoria_all" on public.auditoria;
drop policy if exists "form_campos_all" on public.form_campos;
drop policy if exists "form_opcoes_all" on public.form_opcoes;

create policy "funcionarios_all" on public.funcionarios for all to anon, authenticated using (true) with check (true);
create policy "solicitacoes_all" on public.solicitacoes for all to anon, authenticated using (true) with check (true);
create policy "solicitacao_itens_all" on public.solicitacao_itens for all to anon, authenticated using (true) with check (true);
create policy "usuarios_all" on public.usuarios for all to anon, authenticated using (true) with check (true);
create policy "auditoria_all" on public.auditoria for all to anon, authenticated using (true) with check (true);
create policy "form_campos_all" on public.form_campos for all to anon, authenticated using (true) with check (true);
create policy "form_opcoes_all" on public.form_opcoes for all to anon, authenticated using (true) with check (true);

-- ========== SEED CAMPOS ==========
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

-- ========== SEED OPÇÕES ==========
insert into public.form_opcoes (grupo, valor, label, ordem) values
  ('setor_solicitante', 'QUALIDADE', 'QUALIDADE', 1),
  ('setor_solicitante', 'SEGURANÇA', 'SEGURANÇA', 2),
  ('setor_solicitante', 'TRANSPORTE', 'TRANSPORTE', 3),
  ('setor_solicitante', 'PLANEJAMENTO', 'PLANEJAMENTO', 4),
  ('setor_solicitante', 'ALMOXERIFADO', 'ALMOXERIFADO', 5),
  ('setor_solicitante', 'MEIO AMBIENTE', 'MEIO AMBIENTE', 6),
  ('setor_solicitante', 'SAUDE', 'SAUDE', 7),
  ('setor_solicitante', 'PRODUÇÃO', 'PRODUÇÃO', 8),
  ('equipamento', 'ED-2012KS-01', 'ED-2012KS-01', 1),
  ('equipamento', 'TR-2012KS-11', 'TR-2012KS-11', 2),
  ('equipamento', 'TR-2036KS-23', 'TR-2036KS-23', 3),
  ('equipamento', 'CT-2020KS-04', 'CT-2020KS-04', 4),
  ('equipamento', 'TR-2091KS-01', 'TR-2091KS-01', 5),
  ('equipamento', 'TR-2011KS-15', 'TR-2011KS-15', 6),
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
  ('turno', 'Dia', 'Dia', 1),
  ('turno', 'Noite', 'Noite', 2),
  ('turno', 'Extensão de Horário', 'Extensão de Horário', 3)
on conflict (grupo, valor) do nothing;
