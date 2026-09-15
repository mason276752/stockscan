# stockscan

Node.js server + Vue 網頁：抓取 SEC EDGAR 上的 Inline XBRL 財報（10-K / 10-Q / 20-F / 40-F），
直接解析 iXBRL 檔案，輸出資產負債表、損益表、現金流量表、股東權益變動表的原始數據，
可以挑選任一年度 / 季度瀏覽。

- 資料來源只有 Inline XBRL 本體（`ix:nonFraction` / `xbrli:context` / `xbrli:unit`）
  加上同資料夾的 extension taxonomy（`.xsd` / `_pre.xml` / `_lab.xml`），用來決定報表分類、行順序與標籤。
- 數值為 XBRL 原值（已套用 `scale` 與 `sign`，未依 `negatedLabel` 翻轉），並保留顯示文字 `raw`。
- 公司的申報清單每 10 分鐘重新向 SEC 抓一次，所以永遠看得到最新一份；已申報的文件不會變，
  解析結果存在本機 SQLite（`data/stockscan.sqlite`，Node 內建 `node:sqlite`，不需額外安裝），重啟不用重抓。
- 公司代號表也存在 SQLite，啟動時先用存檔回應搜尋，背景再向 SEC 更新（之後每天一次）。
- 閒置時背景預抓：看某一份申報時，會在沒有使用者請求 3 秒後，悄悄下載前後一期、去年/明年同一季、以及同年度其他申報
  （讓 Q4 推算即時）。預抓請求一律讓路給使用者操作。`GET /api/status` 可看存檔數與預抓佇列。
- 啟動後背景爬蟲：把每家有股票代號的公司（約 6,300 家，公眾流通市值大的先）最新一份 10-K / 10-Q / 20-F 存到本機，
  一輪約 5 小時（每份約 3 秒，低優先權、使用者操作時暫停），之後每 30 分鐘讀 EDGAR 的 daily index 抓當天新申報，
  每週再掃一輪。已檢查過的公司會記錄，重啟後從上次的位置繼續。頁面上方顯示進度；`STOCKSCAN_CRAWL=0` 可關閉。
  存檔以 gzip 壓縮（每份約 40 KB，全部約 250 MB）。

## 安裝與啟動

需要 Node.js 20+。SEC 規定 User-Agent 必須寫明身分（公司/個人名稱 + Email），否則回 403。

```bash
npm install                # 同時安裝 web/ 的依賴
npm run build:web          # 編譯 Vue 前端到 web/dist

export SEC_USER_AGENT="YourName you@example.com"
npm start                  # http://localhost:3000
```

開發模式（後端自動重啟、前端 HMR）：

```bash
SEC_USER_AGENT="YourName you@example.com" npm run dev     # 後端 :3000
npm --prefix web run dev                                  # 前端 :5173，/api 代理到 :3000
```

環境變數：`SEC_USER_AGENT`（必填）、`PORT`（預設 3000）、`STOCKSCAN_DB`（SQLite 路徑，預設 `./data/stockscan.sqlite`）、`STOCKSCAN_CRAWL=0`（關閉背景爬蟲）。

## 網頁

打開 http://localhost:3000 ，輸入股票代號（或公司名稱、CIK），左側會列出所有年度的 Q1 / Q2 / Q3 / FY 申報，
點選後右側顯示四張報表（分頁），另有「其他報表」下拉（附註式報表、綜合損益表、Parenthetical）。

- **欄位**：預設「只看本期」，每張報表只留這份申報自己的期間 —— 資產負債表只有本期末、損益表只有本季三個月（10-K 為全年）、
  現金流量表與權益變動表為期初 / 本期 / 期末。10-Q 的現金流量表通常只有年初至今欄，本季 = 年初至今 − 上一季 10-Q 的年初至今，
  期初現金 = 上一季期末（欄位標「推算」）；切到「申報書全部欄位」可看原本的比較期間。
- 科目預設顯示中文（對照表在 `server/lib/zh.js`，涵蓋 us-gaap / ifrs-full 常用科目約 570 個；沒有對照的科目顯示英文並標 `EN`），可切換成英文
- 滑鼠移到科目上會顯示 tooltip：申報書的英文科目、taxonomy 標準名稱、XBRL concept、中文說明（部分科目）、SEC 官方英文定義（來自 MetaLinks.json）
- **Q4 推算**：左側每個年度多一欄「Q4*」，該年度 Q1–Q3 10-Q 與 10-K 齊全時可按「推算」，
  顯示 Q1 / Q2 / Q3 / Q4* / FY 五欄的季度損益表與現金流量表（Q4 = FY − Q1 − Q2 − Q3），
  以及四個季末的資產負債表。推算欄以藍底標示。
- **財務指標**分頁：以所選申報為最後一期，左舊右新，依「五大財務比率」排版：
  資產負債結構（佔總資產%）、財務結構、償債能力、經營能力、獲利能力、現金流量。每個指標的公式在滑鼠 tooltip。兩種檢視：
  - **逐季**：往前 20 季（可選 8 / 12 / 20 / 40）。季度流量在進入週轉率、ROA、ROE、現金流量比率前先年化
    （單季 ×4 或近四季合計），分母用本季末與上季末平均。
  - **逐年（近四季合計）**：往前 5 年（可選 3 / 5 / 8 / 10），每一欄是到該季為止連續四季的合計，
    例如選 2023 Q3 → 2022 Q4+2023 Q1–Q3、2021 Q4+2022 Q1–Q3、…；餘額取該季季末，平均餘額用季末與四季前季末平均。
    選 10-K 或 Q4 時每欄就是完整會計年度，數字與 10-K 一致。
- 單位：原始 / 千 / 百萬 / 十億（每股金額與比率不縮放）
- 依報表顯示反號：把 `negatedLabel` 的行反號，讓數字跟 SEC 上看到的一致
- 顯示 XBRL 概念名稱：在每行下方列出 `us-gaap:Assets` 這類 concept
- 網址帶 `?company=AAPL&accession=...&tab=cash_flow`，可直接分享

### 分類瀏覽

上方「分類瀏覽」可以不用先知道代號，從分類找到公司後點進財報頁（瀏覽器的上一頁會回到原本的清單）：

- **產業分類 (SIC)**：左側依 SIC 大類（A 農林漁牧 … I 服務業）展開 4 碼產業（中文名稱，tooltip 為 SEC 英文原名），右側列出該產業的公司。
  資料來自 SEC「Financial Statement Data Sets」最近四季的 `sub.txt`（每份 10-K / 10-Q / 20-F 的 SIC 與申報身分），
  只從 zip 抽出 `sub.txt`（HTTP Range），不必下載整個 60 MB 的檔案；每週更新一次，存在 SQLite。
- **規模與申報身分**：SEC 依公眾流通市值（非關係人持股市值）把申報公司分為大型加速申報公司（≥ 7 億美元）、加速申報公司
  （7,500 萬 ～ 7 億）、非加速申報公司三種，決定 10-K / 10-Q 的申報期限；WKSI 另外標示。公司清單依公眾流通市值排序，
  市值來自 XBRL frames API 的 `dei:EntityPublicFloat`（10-K 揭露、以第二季末為準）。有些公司把這個數字標錯單位（大 1,000 倍），
  程式用隱含股價、與總資產的比例、去年數字與申報身分本身做合理性檢查，修正過的值標 `*`。
- **ETF 成分股**：ETF 清單來自 SEC「Investment Company Series and Class」資料集（org type 30、代號 ≤ 4 碼，約 5,300 檔，
  加上 SPY / DIA / MDY 這類沒有 series 的單位投資信託）；成分股取自該基金最新的 **Form N-PORT**（每季公開、落後約兩個月），
  依權重排序。N-PORT 只給 CUSIP，對應到 EDGAR 公司的方式：CUSIP → 股票代號（SEC 交割失敗資料 fails-to-deliver 最近 3 個月的檔案）
  → CIK（代號表），找不到時用名稱比對。對應不到的（外國股票、已下市、衍生性商品、現金）以灰色顯示。
- 財報頁左側的 SIC 與申報身分也是連結，點了就到同產業 / 同身分的清單。

## API

| 路徑 | 說明 |
|---|---|
| `GET /api/search?q=goog` | 代號 / 公司名稱建議 |
| `GET /api/status` | 本機存檔數量與大小、預抓佇列、背景爬蟲進度 |
| `GET /api/company/GOOGL` | 公司資料 + 所有 Inline XBRL 財報清單，每筆標上 `fiscalYear` / `fiscalPeriod`（FY、Q1–Q3） |
| `GET /api/company/GOOGL/statements` | 最新一份財報的四大報表 |
| `GET /api/company/GOOGL/statements?year=2025&period=Q2` | 指定年度 / 季度（`period` = FY、Q1、Q2、Q3） |
| `GET /api/company/GOOGL/quarters?year=2025` | 該會計年度的季度拆分：Q1–Q3 來自 10-Q，FY 來自 10-K，Q4 推算 |
| `GET /api/company/GOOGL/indicators?year=2025&period=Q3&n=20&basis=x4` | 到 FY2025 Q3 為止 20 季的財務指標（`basis` = `x4` 單季×4 或 `ttm` 近四季合計） |
| `GET /api/company/GOOGL/indicators?year=2025&period=Q3&mode=year&n=5` | 到 FY2025 Q3 為止 5 年，每年 = 連續四季合計（2024 Q4 + 2025 Q1–Q3 …） |
| `GET /api/filing/1652044/0001652044-26-000048` | 指定 CIK + accession（加 `?view=current` 只留本期欄位；`statements`、`?url=` 也支援） |
| `GET /api/filing?url=https://www.sec.gov/ix?doc=/Archives/...` | 直接貼 SEC 網址 |
| `GET /api/browse/sic` | SIC 大類與 4 碼產業清單（含中文名、公司數） |
| `GET /api/browse/filer` | 申報身分分類與公司數 |
| `GET /api/browse/companies?sic=3674` / `?afs=LAF` | 某產業 / 某申報身分的公司（`listed=0` 含沒有股票代號的申報公司，`q=` 篩選） |
| `GET /api/browse/etf?q=vanguard` | ETF 清單（常用的排前面） |
| `GET /api/browse/etf/VOO` | 該 ETF 最新 N-PORT 的成分股，每筆附對應到的 `cik` / `symbol` 與權重 |

`:id` 可以是股票代號或 CIK。`year` / `period` 找不到時回 404，並附上該公司可用的 `available` 清單。

```bash
curl "localhost:3000/api/company/AAPL/statements?year=2025&period=FY" | jq '.statements.income_statement.lineItems[] | {label, values: (.values | map_values(.value))}'
```

### Q4 推算的做法

10-Q 的損益表通常同時有「三個月」與「年初至今」欄，現金流量表多半只有「年初至今」欄，所以用累計值計算：
C1、C2、C3 取各季 10-Q 的年初至今欄（沒有就用上一季累計 + 三個月欄），C4 取 10-K 全年，Qn = Cn − Cn−1。

- 貨幣金額直接相減；每股金額相減只是近似（各期加權股數不同），輸出時標 `approx: true`，畫面顯示 `≈`；
  股數、比率類不可相減，Q4 留空。
- 公司若在年中換了 concept（例如 Alphabet 2025 年營收從 `RevenueFromContractWithCustomerExcludingAssessedTax`
  換成 `Revenues`），會退而用科目英文名稱與少數已知同義 concept 對應。
- 資產負債表為各季期末餘額（不需推算）；股東權益變動表不提供季度拆分。
- 回傳格式與單一申報相同，多了 `derived: true` 與 `sources`（四份來源申報），
  `columns[].label` 為 Q1/Q2/Q3/Q4/FY，`columns[].derived` 標示是否由相減得出。

### 財務指標的判斷標準

指標名稱旁有標準值的列（例如 流動比率 ≥ 250%），滑鼠移到該列時，每一格依標準著色：符合為淺綠底、不符合為淺紅底、沒有資料不著色。
標準：現金與約當現金佔比 ≥ 25%、負債佔資產比率 ≤ 60%、長期資金佔 PP&E 比率 ≥ 100%、流動比率 ≥ 250%、速動比率 ≥ 150%、
平均收現日數 ≤ 15 天、平均銷貨日數 ≤ 100 天、做生意的完整週期 ≤ 200 天、總資產週轉率 ≥ 1、ROE ≥ 20%、毛利率 ≥ 25%、
營業利益率 ≥ 15%、淨利率 ≥ 10%、EPS > 0、現金流量比率 > 100%、現金流量允當比率 > 100%、現金再投資比率 > 10%
（定義在 `server/lib/indicators.js` 的 `benchmark`）。

### 財務指標的計算

`server/lib/indicators.js` 先用 `quarters.js` 把窗口內每一年的 10-Q / 10-K 拆成季度資料點（流量 + 季末餘額，
Q4 = 全年 − 前三季），再對每一期計算下列指標；概念對照有 US-GAAP 與 IFRS 的候選清單（`C` 表），依序取第一個有值的。

| 類別 | 指標 | 公式 |
|---|---|---|
| 資產負債結構 | 現金、應收帳款、存貨、流動資產、應付帳款、流動負債、長期負債、股東權益 | 各科目 ÷ 總資產 |
| 財務結構 | 負債佔資產比率 | 總負債 ÷ 總資產 |
| | 長期資金佔不動產、廠房及設備比率 | （權益總額 + 非流動負債）÷ PP&E 淨額 |
| 償債能力 | 流動比率 / 速動比率 | 流動資產 ÷ 流動負債 / （流動資產 − 存貨 − 預付費用）÷ 流動負債 |
| 經營能力 | 應收款項週轉率、存貨週轉率、PP&E 週轉率、總資產週轉率 | 年化流量 ÷ 平均餘額；收現 / 銷貨日數 = 365 ÷ 週轉率 |
| 獲利能力 | ROA / ROE | 年化稅後淨利 ÷ 平均總資產 / 平均股東權益 |
| | 稅前純益佔實收資本比率 | 年化稅前淨利 ÷（普通股股本 + 資本公積） |
| | 毛利率、營業利益率、經營安全邊際率、純益率 | 同期流量相除，不需年化 |
| | 每股盈餘、稅後淨利、營業收入 | 單季金額；勾選「金額列也年化」時顯示年化值 |
| 經營能力 | 做生意的完整週期 | 平均銷貨日數 + 平均收現日數 |
| 現金流量 | 現金流量比率 | 年化營業現金流量 ÷ 流動負債 |
| | 現金流量允當比率 | 最近 20 季營業現金流量 ÷ 最近 20 季（資本支出 + 存貨增加 + 現金股利）；不足時用可取得期數（≥4 季） |
| | 現金再投資比率 | （年化營業現金流量 − 年化現金股利）÷（PP&E 毛額 + 長期投資 + 其他資產 + 營運資金） |

逐年檢視時流量為四季合計、不需年化，平均餘額用期末與四季前期末。EPS 為各季申報值相加，沒有做股票分割調整，跨越分割日的期間會失真。
只有年報的公司（20-F / 40-F）以年度為單位，不做年化。Inline XBRL 大型公司從 2019 年中、其他公司從 2021 年中才強制，
更早的期別會顯示「無資料」。

## 輸出格式

```jsonc
{
  "fetchedAt": "2026-09-15T01:10:00.000Z",
  "filing": {
    "cik": 1652044, "companyName": "Alphabet Inc.", "form": "10-Q",
    "filingDate": "2026-04-30", "periodEnd": "2026-03-31",
    "fiscalYear": "2026", "fiscalPeriod": "Q1",
    "accession": "0001652044-26-000048",
    "documentUrl": "https://www.sec.gov/Archives/edgar/data/1652044/000165204426000048/goog-20260331.htm",
    "viewerUrl": "https://www.sec.gov/ix?doc=/Archives/edgar/data/1652044/...",
    "taxonomyFiles": { "xsd": "...", "pre": "...", "lab": "..." }
  },
  "dei": { "DocumentType": "10-Q", "EntityRegistrantName": "Alphabet Inc.", ... },
  "units": { "usd": "USD", "shares": "shares", "usdPerShare": "USD/shares", ... },
  "statements": {
    "balance_sheet":    { ...statement... },
    "income_statement": { ...statement... },
    "cash_flow":        { ...statement... },
    "equity":           { ...statement... }
  },
  "allStatements": [ ...every "Statement" role in the filing, incl. parentheticals & comprehensive income... ],
  "stats": { "facts": 1272, "contexts": 369, "statementRoles": 8 }
}
```

每張報表（statement）：

```jsonc
{
  "type": "balance_sheet",              // balance_sheet | income_statement | comprehensive_income | cash_flow | equity | other
  "title": "CONSOLIDATED BALANCE SHEETS",
  "role": "http://www.google.com/role/CONSOLIDATEDBALANCESHEETS",
  "parenthetical": false,
  "axes": { "us-gaap:StatementEquityComponentsAxis": ["us-gaap:RetainedEarningsMember", ...] },
  "columns": [                          // 報表用到的 context（期間 + 維度）
    { "id": "c-24", "period": { "instant": "2026-03-31" }, "dimensions": {} },
    { "id": "c-1",  "period": { "start": "2026-01-01", "end": "2026-03-31" }, "dimensions": {} },
    { "id": "c-47", "period": { "start": "2026-01-01", "end": "2026-03-31" },
      "dimensions": { "us-gaap:StatementEquityComponentsAxis": "us-gaap:RetainedEarningsMember" } }
  ],
  "lineItems": [                        // 依 presentation linkbase 順序
    { "concept": "us-gaap:AssetsCurrentAbstract", "label": "Current assets:", "depth": 2, "abstract": true, "values": {} },
    {
      "concept": "us-gaap:CashAndCashEquivalentsAtCarryingValue",
      "label": "Cash and cash equivalents",          // 申報書上的英文科目
      "labelStandard": "Cash and Cash Equivalents, at Carrying Value",  // taxonomy 標準名稱（MetaLinks）
      "labelZh": "現金及約當現金",                    // 中文對照，沒有則 null
      "descriptionZh": "現金與三個月內到期、流動性極高的短期投資",   // 中文說明，部分科目才有
      "documentation": "Amount of currency on hand as well as demand deposits ...",  // SEC 定義
      "preferredLabel": "terseLabel",   // negatedLabel / totalLabel / periodStartLabel ...
      "negated": false,                 // true 表示財報顯示時會把 value 反號
      "depth": 3,
      "abstract": false,
      "values": {
        "c-24": { "value": 38063000000, "raw": "38,063", "unit": "USD",
                  "decimals": "-6", "scale": "6", "sign": null,
                  "format": "ixt:num-dot-decimal", "factId": "f-84" },
        "c-23": { ... }
      }
    }
  ]
}
```

- `value`：`raw` 套用 `scale`（×10^scale）與 `sign`（`"-"` 取負）後的數值；`xsi:nil` 的事實 `value` 為 `null` 且 `nil: true`。
- 20-F 的 IFRS 申報若只有一張「Profit or Loss and Other Comprehensive Income」合併報表，會同時放進 `income_statement`。
- 財報上沒有的比率（毛利率、周轉率等）不在輸出裡，請用 concept 自行計算。

## 專案結構

| 檔案 | 內容 |
|---|---|
| `server/index.js` | Express 路由、靜態檔案 |
| `server/lib/secClient.js` | sec.gov HTTP client：User-Agent、10 req/s 限速、重試、高/低優先權（預抓讓路） |
| `server/lib/store.js` | SQLite 存檔：解析後的申報、代號表、申報清單 |
| `server/lib/prefetch.js` | 閒置時背景預抓相鄰申報 |
| `server/lib/crawler.js` | 背景爬蟲：掃過所有有代號公司的最新申報，之後監看 EDGAR daily index |
| `server/lib/edgar.js` | ticker/CIK → 公司與申報清單、會計年度/季度判斷、`ix?doc=` 網址解析 |
| `server/lib/ixbrl.js` | 解析 iXBRL：contexts、units、`ix:nonFraction` / `ix:nonNumeric`、ixt 數值與日期轉換 |
| `server/lib/taxonomy.js` | 解析 `.xsd` role 定義、presentation linkbase、label linkbase（支援 linkbase 內嵌在 xsd 的申報） |
| `server/lib/statements.js` | 把事實依 presentation tree 組成報表，篩選維度、去除雜欄 |
| `server/lib/scrape.js` | 一份申報 → 完整 JSON（含 MetaLinks.json 的標準名稱與定義） |
| `server/lib/zh.js` | us-gaap / ifrs-full 科目中文對照表 |
| `server/lib/current.js` | 「只看本期」檢視：去掉比較欄，現金流量表以年初至今相減得本季 |
| `server/lib/quarters.js` | 季度拆分與 Q4 推算；`yearQuarterPoints` 供指標頁使用 |
| `server/lib/indicators.js` | 財務指標（五大比率）計算 |
| `server/lib/universe.js` | 全部申報公司的 SIC / 申報身分 / 公眾流通市值（Financial Statement Data Sets + frames API） |
| `server/lib/etf.js` | ETF 清單、N-PORT 成分股、CUSIP → 代號 → CIK 對應 |
| `server/lib/remoteZip.js` | 用 HTTP Range 從 sec.gov 的 zip 只抽出需要的檔案 |
| `server/data/sic.json` | SIC 4 碼對照表（SEC 英文名、中文名、大類） |
| `web/` | Vue 3 + Vite 前端（`CompanySearch`、`FilingPicker`、`StatementTable`、`IndicatorsTable`、`BrowsePage`、`CompanyTable`） |
