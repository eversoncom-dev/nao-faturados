-- ============================================================
-- AÉREO — STATUS DE PRAZO DE FATURAMENTO
-- Cole este SELECT no painel Administração → campo "Aéreo"
-- ============================================================

WITH BASE AS (

    SELECT
         CASE vdc.TIPOACCOUNTING WHEN 'D' THEN  '2-AEREO - PENDENTE' ELSE '1-AEREO - A FATURAR' END AS TIPO
        ,vi.[EMPRESA]
        ,vi.[COD_CLIENTE_ATUAL]
        ,vi.[CLIENTE]
        ,vi.[CIA]                                                       AS FORNECEDOR
        ,vi.[TIPO_VENDA]                                                AS PRODUTO
        ,VI.[PASSAGEIRO]                                                AS NOME
        ,VI.[FLUXOVENDA]                                                AS FLUXO

        ,CASE CON.FREQREG
            WHEN 1 THEN '01 - DIARIO'
            WHEN 2 THEN '02 - SEMANAL'
            WHEN 3 THEN '03 - DECENDIAL'
            WHEN 4 THEN '04 - QUINZENAL'
            WHEN 5 THEN '05 - MENSAL'
            WHEN 6 THEN '06 - BIMESTRAL'
         END                                                            AS PERIODO

        ,vi.[MES_EMISSAO]
        ,CONVERT(VARCHAR, vi.[DATA_EMISSAO], 103)                      AS [DATA EMISSAO]
        ,CAST(vi.[DATA_EMISSAO] AS DATE)                               AS DATA_EMISSAO_CALC
        ,CONVERT(VARCHAR, vi.[DT_INCLUSAO],  103)                      AS [DATA INCLUSAO]
        ,CONVERT(VARCHAR, vi.[DT_INCLUSAO],  103)                      AS [DATA RELATORIO]
        ,DATEDIFF(day, vi.[DT_INCLUSAO], vi.[DATA_EMISSAO])            AS [DIAS DE INTEGRACAO]
        ,vi.[RESERVA]
        ,vi.[BILHETE]                                                   AS VENDA
        ,vi.[CODIGO_VENDA]                                              AS CODIGO
        ,vi.[STATUS_TKT]                                                AS [SITUACAO VENDA]
        ,vi.[TARIFA]
        ,vi.[TAXA_EMBARQUE]                                             AS TAXA
        ,vi.[OUTRAS_TAXAS]                                              AS [OUTRAS TAXAS]
        ,vi.[MARKUP]
        ,acc.tarifakandir
        ,acc.taxakandir
        ,CASE WHEN vi.TARIFA        > 0 THEN ROUND((acc.TARIFAKANDIR * 100) / vi.TARIFA,        3) ELSE 0 END AS [TAR - PERCENTUAL KANDIR]
        ,CASE WHEN vi.TAXA_EMBARQUE > 0 THEN ROUND((acc.TAXAKANDIR   * 100) / vi.TAXA_EMBARQUE, 3) ELSE 0 END AS [TAX - PERCENTUAL KANDIR]
        ,'0'                                                            AS EXTRAS
        --,(vi.[TARIFA]+vi.[TAXA_EMBARQUE]+vi.[OUTRAS_TAXAS]+vi.[MARKUP]) AS TOTAL
        ,(ISNULL(vi.[TARIFA], 0) + ISNULL(vi.[TAXA_EMBARQUE], 0) + ISNULL(vi.[OUTRAS_TAXAS], 0) + ISNULL(vi.[MARKUP], 0)) AS TOTAL
        ,vi.[FEE]
        ,vi.REQUISICAO                                                  AS [ITEM OS]
        ,vi.OS
        ,vi.[FORMA_PAGAMENTO]                                           AS [FORMA DE PAGAMENTO]
        ,vi.[FORMA_RECEBIMENTO]                                         AS [FORMA DE RECEBIMENTO]
        ,vi.[STATUS_TKT]                                                AS STATUS
        ,vi.[FATURA_CRE]
        ,vi.[STATUS_FATURAMENTO]
        ,VI.[FATURISTA_AEREO]                                           AS FATURISTA
        ,VI.[RESP_AEREO]                                                AS RESPONSAVEL
        ,vi.[SISTEMA_RESERVA]
        ,VDC.TIPOACCOUNTING

,CASE WHEN vi.COD_CLIENTE_ATUAL in ('1536','7512','7561') THEN 'GUSTAVO DEDE'
WHEN vi.COD_CLIENTE_ATUAL in ('1526') THEN 'GUILHERME MELO'
WHEN vi.COD_CLIENTE_ATUAL in ('107358','1810','103595','1716','1674','1568','1482','11987','7572','1558','1500','107372','107443','1714','1724','1668','1810','103595','1716','1674','1568','1482','11987','7572','1558','1500','107372','107443','1714','24393','1724','1668','1486','183139','160911','7454','1562','28189','1566','7451','7453','498889') THEN 'THALES OLIVEIRA'
WHEN vi.COD_CLIENTE_ATUAL in ('7530','9702','1504','1542','1518','1538','1726','1508','3123','7595','1712','7588','1512','1546','7597','1492','1490','7580','1510','7590','7622','123559','7620','7621','1540','3337','1706','1759','1704','280989','1480','1670','1602','9855','7444','7531','7461') THEN 'ALEX PEREIRA'
WHEN vi.COD_CLIENTE_ATUAL in ('20409','1811','1761','1765','301879','255615','1794','2680','12297','2682','1927','2851','2988','9707','11705','2679','461802','461825','461666','460113','461667','461821','461813','7468','473014','446830','288734','460999','473014','2389','1746','151741','186061','7148','2061','7151','1812','474787','7144','2681') THEN 'RENATO.PEREIRA'
WHEN vi.COD_CLIENTE_ATUAL in ('1922','2683','3133','3605','5029','1524','1718','1718','1742','2882','28942','1758','1720','1722','1678','1698','1684','31458','54','3134','1768','1680','192758','1696','1530') THEN 'LUCAS BRENDO'
WHEN vi.COD_CLIENTE_ATUAL in ('1528','7537','1648','1596','1622','941','1588','1590','1608','1628','1652','1618','1604','1640','1650','1632','1662','1710','1656','1488','1478','1598','107434','1516','1522','1642','9743','1620','1809','1548','7471','1700','1868','1612','1644','2300','1582','1660','1666','1694','1592','1606','1594','1634','1610','1646','1484','1554','1616','1676','1474','1658','1586','1614','1702','1624','427703','1352','1626','472725') THEN 'ERNANDES JUNIOR'
WHEN vi.COD_CLIENTE_ATUAL in ('11518','7433','12201','452595','430683','449238','7594','1520','1738','1689','1672','452056','12979') THEN 'PEDRO HENRIQUE'
WHEN vi.COD_CLIENTE_ATUAL in ('192750','192746','1772','1748','2015','1767','7439','1793','9726','1801','1780','1797','1818','1736','1744','1766','1774','1764','450807','24483','350315200','35031520','584525990','1750','455142','192762','1752','4170','13917','100760','1584','1806','192146','1690','53','449400','13144','449403','1127346','1816','1788','1763','1795','1777','1775','53','7584','169411720','455688','455586','1762','472785','473252','473241','473251','1805','1800','1807','1498','1630','473238','473246','449404','5246','456905','473236','475568','487291','1769','493428','473231','449406','473253') THEN 'GILMARA.DINO'
--WHEN vi.COD_CLIENTE_ATUAL in ('1530') THEN 'SAMUEL JUNIOR'
WHEN vi.COD_CLIENTE_ATUAL in ('2487','24527','11599','11920','7152','62389','1894','1944','1820','97375','11776','7153','121770','12274','11720','460086','264241','7211','7150','2487','7146') THEN 'FILIPI.SILVA'
WHEN vi.COD_CLIENTE_ATUAL in ('1','12005') THEN 'EVERSON.COSTA'
WHEN vi.COD_CLIENTE_ATUAL in ('172616','1734','1730','1476','474932','7593','1494','1732','934','389916','1682') THEN 'WELTON BRITO'
ELSE 'VERIFICAR'
         END                                                            AS [RESPONSAVEL DOIS]

        ,acc.K_observacaofatura                                         AS [MOTIVO SUSPENSAO]

        ,CASE acc.K_observacaofatura
            WHEN 'PAYFLAY - DIVERGENCIAS VALORES'                       THEN 'Ricardo Gonçalves'
            WHEN 'PETROBRAS - ATENDIMENTO ANÁLISE'                      THEN 'Cecilia Brito Freire Monteiro'
            WHEN 'ATENDIMENTO - ANALISE'                                THEN 'Dalva Regina O. Medeiros de Camargo'
            WHEN 'EVENTOS SP - AGUARDANDO LIBERACAO FATURAMENTO'        THEN 'Flavia Araujo Galdino'
            WHEN 'VENDA CANCELADA - ATENDIMENTO'                        THEN 'FATURAMENTO'
            WHEN 'VENDA COM VALORES DIVERGENTES'                        THEN 'FATURAMENTO'
            WHEN 'VENDA CANCELADA'                                      THEN 'FATURAMENTO'
            WHEN 'ERRO NA EMISSAO / ERRO OPERACIONAL'                   THEN 'FATURAMENTO'
            WHEN 'VENDA EM DUPLICIDADE'                                 THEN 'FATURAMENTO'
            WHEN 'SUSPENSO FATURAMENTO - ANALISE DE DADOS'              THEN 'FATURAMENTO'
            WHEN 'APS - CONTESTAÇÃO VALORES / COTAÇÃO'                  THEN 'Roberta Rangel Pires'
            WHEN 'FORNECEDOR - AGUARDANDO REEMBOLSO'                    THEN 'FATURAMENTO'
            ELSE 'VERIFICAR'
         END                                                            AS [ACIONAR O RESPONSAVEL]

        ,acc.K_STATUSVOESYNC                                            AS [STATUS VOESYNC]

    FROM [BI].[dbo].[BI_TUR_AEREO_AGENCIA] vi

    LEFT JOIN  BennerSistemaCorporativo.dbo.BB_PNRACCOUNTINGS        ACC ON ACC.HANDLE     = vi.[CODIGO_VENDA]
    LEFT JOIN  BennerSistemaCorporativo.dbo.BB_VENDASDOCUMENTOS      VDC ON VDC.ACCOUNTING = vi.[CODIGO_VENDA] AND VDC.ENTRADASAIDA = 's'
    LEFT JOIN  BennerSistemaCorporativo.dbo.GN_PESSOAS               CLI ON CLI.HANDLE     = vi.[COD_CLIENTE]
    LEFT JOIN  BennerSistemaCorporativo.dbo.Z_GRUPOUSUARIOS          usu ON usu.handle     = cli.K_FATURISTAAEREO
    LEFT JOIN  BennerSistemaCorporativo.dbo.Z_GRUPOUSUARIOS          usr ON usr.handle     = cli.K_RESPONSAVELAEREO
    INNER JOIN BennerSistemaCorporativo..BB_CLIENTECONTRATOS         CON ON CON.PESSOA     = ACC.BB_CLIENTE
                                                                        AND ACC.DATAEMISSAO BETWEEN CON.INICIO AND CON.TERMINO
                                                                        AND CON.EMPRESA     = ACC.EMPRESA
                                                                        AND (CASE WHEN ACC.EVENTO IS NOT NULL THEN 2 ELSE 1 END) = CON.TIPO

    WHERE vi.[STATUS_FATURAMENTO] NOT IN ('Faturado')
      AND vi.[STATUS_TKT]         = 'ATIVO'
      AND vi.[FORMA_RECEBIMENTO]  IN ('FATURADO','GOVERNO')

AND (
      ISNULL(vi.[TARIFA], 0)
    + ISNULL(vi.[TAXA_EMBARQUE], 0)
    + ISNULL(vi.[OUTRAS_TAXAS], 0)
    + ISNULL(vi.[MARKUP], 0)
) <> 0

),

-- ── Calcula os limites do período de faturamento ──────────────────────────
PERIODOS AS (
    SELECT
        *,
        CAST(GETDATE() AS DATE) AS DATA_ATUAL,

        -- Periodicidade canônica derivada do prefixo numérico de PERIODO
        CASE LEFT(PERIODO, 2)
            WHEN '01' THEN 'DIARIO'
            WHEN '02' THEN 'SEMANAL'
            WHEN '03' THEN 'DECENDIAL'
            WHEN '04' THEN 'QUINZENAL'
            WHEN '05' THEN 'MENSAL'
            ELSE NULL   -- BIMESTRAL (06) ou nulo → NÃO CLASSIFICADO
        END AS PERIODICIDADE,

        -- Primeiro dia do período que contém DATA_EMISSAO_CALC
        CASE LEFT(PERIODO, 2)
            WHEN '01' THEN DATA_EMISSAO_CALC
            WHEN '02' THEN CASE
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN  1 AND  7 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC),  1)
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN  8 AND 14 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC),  8)
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN 15 AND 21 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC), 15)
                ELSE                                                DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC), 22)
            END
            WHEN '03' THEN CASE
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN  1 AND 10 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC),  1)
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN 11 AND 20 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC), 11)
                ELSE                                                DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC), 21)
            END
            WHEN '04' THEN CASE
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN 1 AND 15 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC),  1)
                ELSE                                               DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC), 16)
            END
            WHEN '05' THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC), 1)
            ELSE NULL
        END AS DATA_INICIO_PERIODO,

        -- Último dia do período — EOMONTH garante bissexto e meses com 28/29/30/31 dias
        CASE LEFT(PERIODO, 2)
            WHEN '01' THEN DATA_EMISSAO_CALC
            WHEN '02' THEN CASE
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN  1 AND  7 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC),  7)
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN  8 AND 14 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC), 14)
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN 15 AND 21 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC), 21)
                ELSE                                                EOMONTH(DATA_EMISSAO_CALC)
            END
            WHEN '03' THEN CASE
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN  1 AND 10 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC), 10)
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN 11 AND 20 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC), 20)
                ELSE                                                EOMONTH(DATA_EMISSAO_CALC)
            END
            WHEN '04' THEN CASE
                WHEN DAY(DATA_EMISSAO_CALC) BETWEEN 1 AND 15 THEN DATEFROMPARTS(YEAR(DATA_EMISSAO_CALC), MONTH(DATA_EMISSAO_CALC), 15)
                ELSE                                               EOMONTH(DATA_EMISSAO_CALC)
            END
            WHEN '05' THEN EOMONTH(DATA_EMISSAO_CALC)
            ELSE NULL
        END AS DATA_FIM_PERIODO

    FROM BASE
)

-- ── SELECT FINAL ─────────────────────────────────────────────────────────────
SELECT
    -- ── colunas originais ────────────────────────────────────────────────────
    TIPO, EMPRESA, COD_CLIENTE_ATUAL, CLIENTE, FORNECEDOR, PRODUTO, NOME, FLUXO,
    PERIODO, MES_EMISSAO,
    [DATA EMISSAO], DATA_EMISSAO_CALC,
    [DATA INCLUSAO], [DATA RELATORIO], [DIAS DE INTEGRACAO],
    RESERVA, VENDA, CODIGO, [SITUACAO VENDA],
    TARIFA, TAXA, [OUTRAS TAXAS], MARKUP,
    tarifakandir, taxakandir, [TAR - PERCENTUAL KANDIR], [TAX - PERCENTUAL KANDIR],
    EXTRAS, TOTAL, FEE, [ITEM OS], OS,
    [FORMA DE PAGAMENTO], [FORMA DE RECEBIMENTO], STATUS,
    FATURA_CRE, STATUS_FATURAMENTO, FATURISTA, RESPONSAVEL, SISTEMA_RESERVA,
    TIPOACCOUNTING,
    [RESPONSAVEL DOIS],
    CASE [RESPONSAVEL DOIS]
        WHEN 'GILMARA.DINO'   THEN 'FATURAMENTO - SAO PAULO'
        WHEN 'RENATO.PEREIRA' THEN 'FATURAMENTO - SAO PAULO'
        ELSE 'FATURAMENTO - BRASILIA'
    END AS [FILIAL DE FATURAMENTO],
    [MOTIVO SUSPENSAO], [ACIONAR O RESPONSAVEL], [STATUS VOESYNC],

    -- ── colunas de prazo (novas) ─────────────────────────────────────────────
    PERIODICIDADE,
    DATA_INICIO_PERIODO,
    DATA_FIM_PERIODO,
    DATA_ATUAL,

    -- Dias em atraso: 0 se ainda no prazo, positivo se já venceu
    CASE
        WHEN DATA_EMISSAO_CALC IS NULL OR PERIODICIDADE IS NULL OR DATA_FIM_PERIODO IS NULL THEN NULL
        WHEN DATA_ATUAL <= DATA_FIM_PERIODO THEN 0
        ELSE DATEDIFF(DAY, DATA_FIM_PERIODO, DATA_ATUAL)
    END AS DIAS_EM_ATRASO,

    -- Status principal de prazo
    -- Clientes com ciclo de faturamento personalizado sobrepõem a regra geral do contrato
    CASE
        WHEN COD_CLIENTE_ATUAL = '1526' THEN  -- PETROBRAS: ciclo 26/M-1 a 25/M
            CASE
                WHEN DATA_EMISSAO_CALC IS NULL THEN 'NÃO CLASSIFICADO'
                WHEN DATA_EMISSAO_CALC BETWEEN
                    DATEFROMPARTS(YEAR(DATEADD(MONTH,-1,DATA_ATUAL)), MONTH(DATEADD(MONTH,-1,DATA_ATUAL)), 26)
                    AND
                    DATEFROMPARTS(YEAR(DATA_ATUAL), MONTH(DATA_ATUAL), 25)
                THEN 'DENTRO DO PRAZO' ELSE 'FORA DO PRAZO'
            END
        WHEN COD_CLIENTE_ATUAL = '1530' THEN  -- AG PLANALTO DF: ciclo 21/M-1 a 20/M
            CASE
                WHEN DATA_EMISSAO_CALC IS NULL THEN 'NÃO CLASSIFICADO'
                WHEN DATA_EMISSAO_CALC BETWEEN
                    DATEFROMPARTS(YEAR(DATEADD(MONTH,-1,DATA_ATUAL)), MONTH(DATEADD(MONTH,-1,DATA_ATUAL)), 21)
                    AND
                    DATEFROMPARTS(YEAR(DATA_ATUAL), MONTH(DATA_ATUAL), 20)
                THEN 'DENTRO DO PRAZO' ELSE 'FORA DO PRAZO'
            END
        WHEN COD_CLIENTE_ATUAL = '1486' THEN  -- MRE DIVISAO DO PESSOAL: ciclo 14/M-1 a 13/M
            CASE
                WHEN DATA_EMISSAO_CALC IS NULL THEN 'NÃO CLASSIFICADO'
                WHEN DATA_EMISSAO_CALC BETWEEN
                    DATEFROMPARTS(YEAR(DATEADD(MONTH,-1,DATA_ATUAL)), MONTH(DATEADD(MONTH,-1,DATA_ATUAL)), 14)
                    AND
                    DATEFROMPARTS(YEAR(DATA_ATUAL), MONTH(DATA_ATUAL), 13)
                THEN 'DENTRO DO PRAZO' ELSE 'FORA DO PRAZO'
            END
        WHEN DATA_EMISSAO_CALC IS NULL  THEN 'NÃO CLASSIFICADO'
        WHEN PERIODICIDADE IS NULL      THEN 'NÃO CLASSIFICADO'
        WHEN DATA_FIM_PERIODO IS NULL   THEN 'NÃO CLASSIFICADO'
        WHEN DATA_ATUAL <= DATA_FIM_PERIODO THEN 'DENTRO DO PRAZO'
        ELSE 'FORA DO PRAZO'
    END AS STATUS_PRAZO,

    -- Motivo quando não classificado (NULL para registros classificados normalmente)
    CASE
        WHEN DATA_EMISSAO_CALC IS NULL THEN 'Data de emissão não informada'
        WHEN PERIODO IS NULL           THEN 'Contrato/período não encontrado para o cliente'
        WHEN PERIODICIDADE IS NULL     THEN 'Periodicidade não suportada: ' + ISNULL(PERIODO, '')
        ELSE NULL
    END AS MOTIVO_NAO_CLASSIFICADO

FROM PERIODOS
