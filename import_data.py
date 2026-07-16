import os
import pandas as pd
import tkinter as tk
from tkinter import filedialog
from supabase import create_client
from dotenv import load_dotenv

load_dotenv()

def importar_planilha(caminho=None):
    if caminho is None:
        root = tk.Tk()
        root.withdraw()
        caminho = filedialog.askopenfilename(
            title="Selecione o arquivo de efetivo",
            filetypes=[("Arquivos Excel", "*.xls *.xlsx"), ("Todos os arquivos", "*.*")]
        )
        if not caminho:
            print("❌ Nenhum arquivo selecionado.")
            return

    try:
        df = pd.read_excel(caminho, header=0, dtype=str)
    except Exception as e:
        print(f"❌ Erro ao ler o arquivo: {e}")
        return

    colunas = df.columns.tolist()
    colunas_norm = [c.strip().upper() for c in colunas]

    idx_matricula = None
    idx_nome = None
    idx_funcao = None

    for i, col in enumerate(colunas_norm):
        if 'FOLHA' in col or 'Nº FOLHA' in col or 'N° FOLHA' in col:
            idx_matricula = i
        elif col == 'NOME':
            idx_nome = i
        elif 'FUNÇÃO' in col or 'FUNCAO' in col:
            idx_funcao = i

    if None in (idx_matricula, idx_nome, idx_funcao):
        print("⚠️ Usando as três primeiras colunas como Matrícula, Nome e Função.")
        idx_matricula, idx_nome, idx_funcao = 0, 1, 2

    df = df.rename(columns={
        colunas[idx_matricula]: 'matricula',
        colunas[idx_nome]: 'nome',
        colunas[idx_funcao]: 'funcao'
    })
    df = df[['matricula', 'nome', 'funcao']]
    df = df.dropna(subset=['matricula'])
    df['matricula'] = df['matricula'].astype(str).str.strip()
    df['nome'] = df['nome'].astype(str).str.strip()
    df['funcao'] = df['funcao'].astype(str).str.strip()

    supabase = create_client(
        os.getenv("SUPABASE_URL"),
        os.getenv("SUPABASE_KEY")
    )

    # Substituição completa
    supabase.table('funcionarios').delete().neq('matricula', '').execute()
    registros = df.to_dict('records')
    for i in range(0, len(registros), 500):
        supabase.table('funcionarios').upsert(registros[i:i + 500]).execute()

    print(f"✅ Importação concluída! {len(df)} registros.")

if __name__ == '__main__':
    importar_planilha()