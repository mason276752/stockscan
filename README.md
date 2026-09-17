# stockscan

Node.js server + Vue 網頁：抓取 SEC EDGAR 上的 Inline XBRL 財報（10-K / 10-Q / 20-F / 40-F），
直接解析 iXBRL 檔案，輸出資產負債表、損益表、現金流量表、股東權益變動表的原始數據，
可以挑選任一年度 / 季度瀏覽。

- 資料來源只有 Inline XBRL 本體（`ix:nonFraction` / `xbrli:context` / `xbrli:unit`）
  加上同資料夾的 extension taxonomy（`.xsd` / `_pre.xml` / `_lab.xml`），用來決定報表分類、行順序與標籤。
- 數值為 XBRL 原值（已套用 `scale` 與 `sign`，未依 `negatedLabel` 翻轉），並保留顯示文字 `raw`。
- 公司的申報清單每 10 分鐘重新向 SEC 抓一次，所以永遠看得到最新一份；已申報的文件不會變，
  解析結果存在本機 `data/store/`（一份財報一個 zstd 壓縮的 JSON 小檔，放在 repo 的 `refs/data/main`，見「資料存放」），重啟不用重抓。
- 一份申報的 Inline XBRL 可能拆成多個檔（10-K 的財報放在 `xxx_d2.htm`），依 FilingSummary.xml 的 InputFiles 全部解析後合併；
  同一個命名空間宣告兩個前綴（`xmlns:i` 與 `xmlns:xbrli`）或 linkbase 同時有預設命名空間與前綴的申報也能解析。存檔裡報表沒有任何欄位的會在讀取時重新解析。
- 公司代號表存在本機快取（`data/cache.sqlite`）並留一份在 `data/store/tickers.json`（在 data ref 裡，沒有快取時用），申報清單存在 `data/store/companies/`；啟動時先用存檔回應搜尋，背景再向 SEC 更新（之後每天一次）。每次更新成功後，**已不在代號表的公司（已下市、下櫃、被收購、撤銷登記）的財報與評分會從資料庫移除**，爬蟲也不再抓它們（只在代號表完整下載、筆數合理時才清，避免下載不全誤刪）。
- 閒置時背景預抓：看某一份申報時，會在沒有使用者請求 3 秒後，悄悄下載前後一期、去年/明年同一季、以及同年度其他申報
  （讓 Q4 推算即時）。預抓請求一律讓路給使用者操作。`GET /api/status` 可看存檔數與預抓佇列。
- 啟動後背景爬蟲：把每家有股票代號的公司（約 6,300 家，公眾流通市值大的先）最近 5 期 10-K / 10-Q / 20-F 存到本機
  （每份約 3 秒，低優先權、使用者操作時暫停），每週再掃一輪。**當天的新申報**另外靠 EDGAR 的 daily index：每 30 分鐘讀一次，
  掃描進行中也照讀（不用等整輪掃完），抓到就存檔、計分，頁首會顯示「新申報監看 時間，今起已抓 N 份」，`/api/status` 的 `crawler.watchLog` 列出最近抓到的。已檢查過的公司會記錄，重啟後從上次的位置繼續。頁面上方顯示進度；`STOCKSCAN_CRAWL=0` 可關閉。
  存檔以 gzip 壓縮（每份約 40 KB，全部約 250 MB）。
- 財報之外：財務指標與評分、股價估值、分類瀏覽（SIC / 申報身分 / ETF 成分股）、尋找股票、觀察名單，
  以及把篩選結果或觀察名單組成**自製 ETF**畫日 K（股價一律 TradingView → IBKR TWS → Yahoo；圖表為 TradingView Advanced Charts）。

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

環境變數：`SEC_USER_AGENT`（必填）、`PORT`（預設 3000）、`BASE_URL`（路徑前綴，見下）、`STOCKSCAN_STORE`（財報 / 評分目錄，預設 repo 的 `data/store`）、`STOCKSCAN_CACHE`（快取 SQLite，預設 `data/cache.sqlite`）、`STOCKSCAN_BARS`（日線目錄，預設 `data/bars`；這些預設都相對於 repo，不是執行時的工作目錄）、`STOCKSCAN_DB`（舊版單檔 SQLite，啟動時若 store 目錄是空的會自動搬過去）、`STOCKSCAN_CRAWL=0`（關閉背景財報爬蟲）、`STOCKSCAN_BARS_CRAWL=0`（關閉每日收盤後全市場日線的背景抓取）；
自製 ETF 的日線：`TV_ENABLED=0`（不用 TradingView websocket）、`IB_HOST`（預設 127.0.0.1）、`IB_PORT`（預設 7496；TWS 模擬帳戶 7497、IB Gateway 4001 / 4002）、`IB_CLIENT_ID`（預設 100 + PORT 的後三位，兩個 server 才不會互踢）、`IB_ENABLED=0`（不連 TWS，改用 Yahoo）。

### 純前端版（沒有伺服器也能跑）

同一份程式碼可以編成兩種部署：

| | 前後端版（`npm start` / Docker） | 純前端版（`npm run build:static`） |
|---|---|---|
| 財報頁：四大報表、其他報表、只看本期、Q4 推算、財務指標、評分 | ✅ | ✅ 在瀏覽器裡算（同一套 `server/lib` 模組） |
| 尋找股票、分類瀏覽（產業 / 申報身分 / ETF 成分股）、搜尋 | ✅ 即時 | ✅ build 當時的快照 |
| 觀察名單、K 線圖分頁、自製 ETF 的 TradingView widget 模式 | ✅ | ✅（嵌入圖由 tradingview.com 載入——純前端版唯一會連的外部服務） |
| 自製 ETF 自己算的指數與成分股報酬 | ✅ 伺服器抓日線（TradingView，備用 TWS、Yahoo） | ✅ 日線隨網站發布（`data/bars`，排程從 TradingView 抓到前一個交易日），瀏覽器自己算，不連外 |
| 抓 SEC 新申報、爬蟲、「更新」 | ✅ | ✗ 瀏覽器不連 SEC；資料由排程重新建置（每個交易日數次） |
| 股價估值 | ✅ 申報封面股數、Yahoo 分割事件與匯率 | ✅ 用隨網站發布的十年日線算；沒有封面股數（用各期稀釋加權平均）、沒有分割事件（由各期股數的整倍數跳動推得）、沒有匯率（非美元財報的每股數字不換算，頁面會標示） |
| ETF 每日持股（SSGA / Nasdaq） | ✅ | ✗ 用 build 時的 N-PORT 季報成分 |

```bash
npm run build:static        # -> web/dist-static/（網頁 + data/store + data/bars + index/，約 550 MB）
# 慢的部分（複製 900 MB 的 store、解開 6 萬個財報／評分檔取表頭、索引 zstd -19）交給 Rust 寫的
# tools/stockscan-static 平行處理：Linux x86_64 的 binary 已 commit 在 tools/stockscan-static/bin/（Pages 的
# workflow 直接跑它，不編譯；改了 src/ 後用 build-linux.sh 在 Docker 裡重編再 commit）；其他平台有 cargo
# 時第一次會自己 build；都沒有就走純 Node（結果相同、慢約 3 倍）。STOCKSCAN_STATIC_NATIVE=0 強制純 Node；
# --link 用 hard link 代替複製（CI 用）。
# 放到任何靜態主機；手動推 GitHub Pages 的話：npx gh-pages -d web/dist-static -t
```

**GitHub Actions 自動部署**（[.github/workflows/pages.yml](.github/workflows/pages.yml)）：push 到 `main` 就 build 並發佈到 GitHub Pages。要先做兩件事：
repo 的 Settings → Pages → Source 選 **GitHub Actions**；`SEC_USER_AGENT`（`名字 email`）用 Settings → Secrets 的同名 secret，沒設就用 workflow 檔裡寫的預設值。
**資料在 `refs/data/main`，不在 `main`**（見「資料存放」）：workflow checkout `main`（程式），再把 `refs/data/main`（`data/store`、`data/bars`）fetch 到 `data-repo/`，用 `STOCKSCAN_STORE` / `STOCKSCAN_BARS` 指過去；push 程式碼因此只帶程式的 diff，不再拖著十幾萬個資料檔。
Runner 上沒有快取，build 會自己向 SEC 抓代號表與產業宇宙、向 TradingView 抓市場快照（約 3–4 分鐘）；財報、申報清單、以及 SEC 抓不到時的代號表與產業宇宙，直接用 data ref 裡的 `data/store`。代號表或產業宇宙完全拿不到時 build 會失敗（exit 1），不會把搜尋不到東西的網站部署出去。
除了 push，也**定時**跑（cron 是 UTC，美東夏令 UTC-4、冬令 UTC-5，每個時間以其中一種寫、另一種會差一小時）：財報在最常出現的時段——美東 08:30、17:45、22:30（夏令）；
日線則要在當天的 K 棒收完之後——16:00 收盤那根在 17:45 那次就有了，但 12 月起美股改成 23 小時交易（美東 20:00 到隔天 19:00，19:00–20:00 休市），整天的 K 棒只在那一小時是定案的，所以另外排 23:30 UTC（夏令 19:30）和 00:30 UTC（冬令 19:30）各一次，兩種時制總有一次落在休市那小時。
每次都先 `npm run fetch:new` 從 EDGAR 每日索引把最近幾天新的 10-K / 10-Q 抓下來、解析、評分，
在 `refs/data/main` 上**多 commit 一個並 push**（推這個 ref 不會觸發 workflow，`main` 完全不動；一定要接在前一個 commit 後面——git 只送父 commit 沒有的物件，孤兒 commit 或改寫過的 ref 每次都會重送整個 600 MB），再用新資料重建網站。`fetch:new` 在本機也能跑，等於爬蟲「監看新申報」那一步跑一次就結束。
日線：data ref 裡只有已結束年份的 `data/bars/**/<年>.zst`，每次 build 前 `npm run fetch:bars` 從 TradingView 把今年的 `head.zst` 補到最新（8 條並發約 12 分鐘；`actions/cache` 在兩次 run 之間留住 head，之後每次只接最後幾根），
放進站台但不 commit（data ref 的 `.gitignore` 排除 head.zst）；跨年封成 `<年>.zst` 時會跟著那次 push 進去。TradingView 抓不到（例如 runner 的 IP 被擋）也不會讓 build 失敗，只是自製 ETF 頁的日線停在去年底。

- 瀏覽器端：財報 / 評分的 `.zst` 檔名帶版本、內容永不變，抓過一次就放進 Cache Storage 不再下載；`index/*.json.zst` 以 build 時間為版本，換一次 build 才重抓。
  另有 service worker（[web/public/sw.js](web/public/sw.js)，只在純前端版註冊）：app shell（`index.html` 與 `assets/` 的 hash 檔）走快取、離線也能開，`index.html` 本身 network-first 所以新部署下次開就生效、舊 assets 會照新頁面引用的清單清掉；
  每次部署都會變的小檔（`index/meta.json`、今年的 `head.zst`）network-first、離線時用上次的。財報、字典、已結束年份的日線由 app 自己的 Cache Storage 管，service worker 不再存一份。
- 閒置預抓（[web/src/prefetch.js](web/src/prefetch.js)，兩種版本都有）：瀏覽器閒置、且沒有使用者要的東西在載入時，一次一件把「接下來很可能會點的」先抓好——
  開了一家公司後依序抓這份申報的評分、目前設定的財務指標、TradingView 代號、申報表裡接下來三份申報；停留 8 秒後再抓股價估值（要抓十年日線，不為路過的公司抓）。
  純前端版啟動時先把搜尋 / 公司 / 評分 / 科目說明索引抓好，再抓尋找股票與分類瀏覽用的大索引。結果進同一個 memo（[memo.js](web/src/memo.js)）／Cache Storage，之後點到就直接用；換公司時還沒跑的會丟掉，`navigator.connection.saveData` 開著就完全不預抓。
  預抓在畫面上有任何載入中指示時都會等（`busy.count`）——使用者正在等的那個檔不會被背景下載搶頻寬；慢速連線（瀏覽器判定 3G 以下或低於 1.5 Mb/s）不預抓大索引（0.3–3.5 MB 那幾個），用到再抓。
  索引全部 zstd 壓過再放上去（靜態主機不一定會壓，瀏覽器反正已經為了財報載了 zstd-wasm），檔名帶內容 hash（`screen.735697c7d8.json.zst`，`meta.json` 的 `files` 說這次 build 各索引是哪個檔）：每天重建時內容沒變的（產業宇宙、科目說明、ETF 清單）瀏覽器就不必重抓，Cache Storage 裡舊 build 的索引在拿到新 `meta.json` 時清掉；只有 `meta.json` 是明文（第一個抓、帶 build 時間）。
  尋找股票的索引是欄位式（一個欄位一個陣列，`screen.js` 的 `screenColumns`）：比一列一個物件少四分之三的 JSON、parse 快一倍多，`screenQuery` 直接在欄位上篩選排序（數值欄是 `Float64Array`），只把回傳的那幾百列組回物件——伺服器那邊仍是每次請求現組的列物件，同一個 `screenQuery` 兩種都吃。
  它分兩個檔：`screen.json.zst`（公司、評分、最新一份的 66 個指標、市場快照，1.6 MB）與 `screen-history.json.zst`（前一份與去年同期的對照，1.8 MB）——第一頁只等前者；「較前期」「較去年同期」的條件、排序或欄位（頁面帶 `history=1`）才等後者（`wantsHistory`）。
- 純前端版的資料層跑在 Web Worker（[api.static.worker.js](web/src/api.static.worker.js)；頁面上的 [api.static.js](web/src/api.static.js) 只是把每個呼叫轉過去的 proxy）：抓檔、zstd 解壓、JSON parse、解財報算指標、算自製 ETF 指數與股價估值全在 worker 裡，索引也留在 worker 不搬回頁面，只有結果過線——主執行緒沒有任何 long task（之前載尋找股票索引會卡 ~130 ms）。錯誤訊息要用的語言隨每個請求帶過去（[locales/translate.js](web/src/locales/translate.js)，無 Vue 的 `t()`）。
  32 KB 以上的下載 worker 逐段讀、回報進度（`busy.downloads`）：頂端那條進度條在有已知大小的下載時顯示真實百分比，載入中的訊息旁顯示「1.2 / 1.6 MB」。

- 輸出目錄裡：Vue app（`VITE_STATIC=1` 編譯，資料層換成 [api.static.js](web/src/api.static.js)）、`data/store` 原樣複製、`data/zdict` 字典、
  `index/*.json.zst`（靜態主機列不出目錄，所以先產好：公司與其申報清單、代號表、最新評分、尋找股票的整張表、產業宇宙、TradingView 代號、熱門 ETF 成分）。
- 瀏覽器用 WASM zstd（`@bokuweb/zstd-wasm`）配同一份字典解開 `.json.zst`，再跑 `current.js` / `quarters.js` / `indicators.js` / `scoreModel.js` / `screen.js` 這些純計算模組——它們和伺服器用的是同一份檔案。
- 用相對路徑，放在子路徑（`https://user.github.io/stockscan/`）也不用改設定。
- 頁首會標「純前端版 · N 份財報 · 資料更新至 <build 日期>」（tooltip 說明資料來源與唯一的外連）；不支援的功能會直接說明。

### 資料存放（`refs/data/main`）

資料不在 `main`，也不在任何 branch：`data/store` 與 `data/bars` 放在同一個 repo 的 ref **`refs/data/main`**（獨立的歷史，跟 `main` 沒有共同祖先；Pages 的 workflow 抓到新申報就在上面多 commit 一個）。
放在 `refs/heads/` 之外是為了 **`git clone` 不會抓它**——clone 只有程式（幾 MB），GitHub 也不會把它列成 branch；`main` 的 `.gitignore` 整個忽略 `data/`。
本機要跑伺服器版或 `npm run build:static`，把資料取回工作目錄（之後 server 的爬蟲會在同一個目錄繼續補）：

```bash
npm run data:pull      # = scripts/pull-data.sh：只抓 data ref 的 tip（--depth=1），git restore 到工作目錄，不 merge、不 rebase、不切 branch
```

之後想更新成 workflow 最新抓到的，再跑一次即可。不要把它 merge 進 `main`。

```
data/store/filings/<cik>/<accession>__<期末>__<表別>__v<解析版本>.json.zst  一份財報一檔（zstd JSON，約 10 KB）
data/store/scores/<cik>/<accession>__<期末>__v<評分版本>.json.zst           一份財報一個評分（約 0.5 KB）
data/store/documentation.json                                             標準科目的 SEC 定義，全站一份（不再每份財報重複存）
data/store/tickers.json                                                   EDGAR 代號表的副本（快取沒有時用：新 clone、CI runner）
data/store/companies/<CIK 10 碼>.json                                      每家公司的 EDGAR 申報清單（裁剪過的 submissions）：財報頁左側清單、爬蟲比對用
data/bars/<來源>/<SYMBOL>/<年>.zst                                        日線，一個代號一年一檔（欄式 zstd，約 2.5 KB）：已結束的年份，寫完就不再動
data/bars/<來源>/<SYMBOL>/meta.json                                       代號、來源、幣別、有哪些年份、分割調整（adjust）；只在封年或分割時才變
data/bars/<來源>/<SYMBOL>/head.zst                                        今年的日線 + 抓取時間：唯一每天在長的檔（不進 data ref，Pages 的 workflow 自己抓）
data/cache.sqlite                                                         快取：代號表、申報清單、市場快照…（.gitignore）
```

- 財報一旦申報就不會變，所以每個檔寫一次就不動；解析或評分版本升級時舊檔刪掉重建。檔名就是索引（啟動時掃目錄，約 0.6 秒），沒有另外的索引檔會不同步。
- 這樣設計是為了能**直接放進 git**：全是小檔（沒有任何檔接近 100 MB 上限）、不需要 Git LFS；目前約 30,000 份財報加十年日線約 940 MB，每月成長約 15 MB。放在 `refs/data/main` 而不是 `main`，push 程式碼才不用每次都處理十幾萬個檔的 tree，clone 也不會拿到它。
- 儲存時把重複的四大報表引用（`statements` 只是 `allStatements` 的子集）拿掉、標準科目的 SEC 定義集中到 `documentation.json`，
  再用 **zstd + 字典**壓（`server/data/zdict/`，字典以 1,500 份財報 / 評分訓練，`node server/tools/train-zdict.mjs` 可重新訓練，但用過的字典不能改）：
  財報比 brotli 再小 36%、評分小 70%，解壓 0.2 ms；壓一份要 ~0.08 秒，只在爬蟲存檔時付。舊的 `.json.br` 照樣能讀，啟動 20 秒後在背景逐檔轉成 `.zst`。
- **從舊版搬移**：第一次啟動時若 `data/store/` 是空的而 `data/stockscan.sqlite` 存在，會自動搬（約 1 分鐘，log 有進度），搬完舊檔可刪。
- **clone 下來就是完整的**：財報、評分、申報清單都在 `data/store/`，所以新環境開任何一家公司不用等下載，爬蟲掃描時「最近 5 期都已存」的公司**一個請求都不會發**（申報清單一週內的就直接用；當天的新申報由每日索引監看補上）。`data/cache.sqlite` 只剩真正的快取（代號表、市場快照、產業宇宙、ETF 清單），刪掉也只是重抓這些。

### 路徑前綴（BASE_URL）

放在反向代理的子路徑下（例如 `https://host/stockscan/`）時設 `BASE_URL=/stockscan`，前後端一起生效：
API 變成 `/stockscan/api/...`、TradingView 函式庫 `/stockscan/tradingview/...`、網頁在 `/stockscan/`（`/stockscan` 會 301 到有斜線的），前綴外的路徑回 404。
前端 build 用相對路徑，伺服器送出 `index.html` 時注入前綴，所以**同一份 build 換 `BASE_URL` 不用重編**；
開發模式 `BASE_URL=/stockscan npm --prefix web run dev` 也會讓 Vite 在同樣前綴下跑並代理到後端（後端位址 `VITE_BACKEND`，預設 `http://localhost:3000`）。

### Docker

```bash
cp .env.example .env         # 填 SEC_USER_AGENT（必填）、BASE_URL、PORT…
docker compose up -d --build # http://localhost:3000（或 BASE_URL 下）
```

- `Dockerfile` 兩階段：先 build 前端（含 `web/assets/tradingview/` 的授權版 Advanced Charts，有放才會複製），再以 Node 24 alpine 跑 server（僅 production 依賴，非 root）。
- `./data` 掛進容器的 `/app/data`：`data/store/`（財報、評分，`npm run data:pull` 取回的那份）與 `data/cache.sqlite` 在重建映像後保留；映像本身不含資料。
- 連主機上的 TWS / IB Gateway：`IB_HOST` 預設 `host.docker.internal`（Linux 由 compose 的 `extra_hosts` 提供）；TWS 的 API 設定要關掉「只允許 localhost 連線」並信任 Docker 網段的 IP，否則自製 ETF 的日線走 TradingView / Yahoo。
- 健康檢查打 `/api/status`（含前綴）。

## 網頁

打開 http://localhost:3000 ，輸入股票代號（或公司名稱、CIK），左側會列出所有年度的 Q1 / Q2 / Q3 / FY 申報，
點選後右側顯示四張報表（分頁），另有「其他報表」下拉（附註式報表、綜合損益表、Parenthetical）。

- **欄位**：預設「只看本期」，每張報表只留這份申報自己的期間 —— 資產負債表只有本期末、損益表只有本季三個月（10-K 為全年）、
  現金流量表與權益變動表為期初 / 本期 / 期末。10-Q 的現金流量表通常只有年初至今欄，本季 = 年初至今 − 上一季 10-Q 的年初至今，
  期初現金 = 上一季期末（欄位標「推算」）；切到「申報書全部欄位」可看原本的比較期間。
- **語言**：介面支援中文 / 英文，第一次造訪依瀏覽器（系統）語言決定，右上角可切換，選擇存在 localStorage。
  介面文字在 `web/src/locales/zh.js`、`en.js`；指標名稱、公式、單位這類由 `server/lib` 產生的中文字串，英文版在 `en.js` 的 `data` 表對照。
  財報科目跟著介面語言：中文介面顯示中文對照，英文介面顯示申報書原文。
- 科目的中文對照表在 `server/lib/zh.js`、`zh-more.js`、`zh-batch3.js`（約 3,000 個 us-gaap / ifrs-full 標準科目、大型公司自訂科目，
  以及約 600 個多家公司共用的自訂科目名稱（SPAC 的應付發行費用、遞延承銷費、非現金租賃費用、法定盈餘公積、航次費用…）；
  以已下載的 7,800 份財報統計，四大報表的科目 90% 有中文、標準科目 98.7% 有中文；沒有對照的科目顯示英文並標 `EN`）。
  公司自訂科目（`aapl:`、`jpm:` 這類前綴）若名稱與標準科目相同、或只是拼法不同（單複數、`NonCash` / `Noncash`、`NonCurrent` / `Noncurrent`、結尾數字）會沿用其翻譯。
  中文對照在讀取存檔時套用，新增翻譯不必重抓財報
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
  - **同季比較（歷年同一季）**：只看所選季度，往前 5 年（可選 3 / 5 / 8 / 10），例如選 2023 Q3 → 2019 Q3、2020 Q3、…、2023 Q3 五欄，
    每欄是該季的單季數字（年化方式同逐季），避開季節性直接比年增。
- 單位：原始 / 千 / 百萬 / 十億（每股金額與比率不縮放）
- 簡化（預設開）：四大報表只留合計欄，隱藏 XBRL 維度分欄（股本組成、股別、產品線、關係人…）。
  合計欄空白但分欄有數字的行（例如只按股別標記的發行新股、只按產品線標記的營業成本），
  把同一軸的成員加總填入並標 Σ；申報書某一期只有分欄沒有合計欄時（10-Q 權益變動表的上一季）整欄以分欄加總補上。
  取消勾選可看完整分欄，其他報表（附註明細）不受影響。
- 依報表顯示反號：把 `negatedLabel` 的行反號，讓數字跟 SEC 上看到的一致
- 顯示 XBRL 概念名稱：在每行下方列出 `us-gaap:Assets` 這類 concept
- 網址帶 `?company=AAPL&accession=...&tab=cash_flow`，可直接分享

### 分類瀏覽

上方「分類瀏覽」可以不用先知道代號，從分類找到公司後點進財報頁（瀏覽器的上一頁會回到原本的清單）：

- **產業分類 (SIC)**：左側依 SIC 大類（A 農林漁牧 … I 服務業）展開 4 碼產業（中文名稱，tooltip 為 SEC 英文原名），右側列出該產業的公司。
  資料來自 SEC「Financial Statement Data Sets」最近四季的 `sub.txt`（每份 10-K / 10-Q / 20-F 的 SIC 與申報身分），
  只從 zip 抽出 `sub.txt`（HTTP Range），不必下載整個 60 MB 的檔案；每週更新一次，存在快取。
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
| `GET /api/company/GOOGL/indicators?year=2025&period=Q3&mode=same&n=5` | 歷年同一季：2021 Q3、2022 Q3、…、2025 Q3 的單季指標 |
| `GET /api/filing/1652044/0001652044-26-000048` | 指定 CIK + accession（加 `?view=current` 只留本期欄位；`statements`、`?url=` 也支援） |
| `GET /api/filing?url=https://www.sec.gov/ix?doc=/Archives/...` | 直接貼 SEC 網址 |
| `GET /api/company/AAPL/valuation?year=2026&period=Q3&n=20[&adr=5]` | 股價估值：各期倍數（期末股價）、現在倍數、歷史倍數反推的合理價、絕對估值模型（預設假設） |
| `GET /api/browse/sic` | SIC 大類與 4 碼產業清單（含中文名、公司數） |
| `GET /api/browse/filer` | 申報身分分類與公司數 |
| `GET /api/browse/companies?sic=3674` / `?afs=LAF` | 某產業 / 某申報身分的公司（`listed=0` 含沒有股票代號的申報公司，`q=` 篩選） |
| `GET /api/browse/etf?q=vanguard` | ETF 清單（常用的排前面） |
| `GET /api/browse/etf/VOO` | 該 ETF 最新 N-PORT 的成分股，每筆附對應到的 `cik` / `symbol` 與權重 |
| `GET /api/bars/AAPL` | 十年日 K（開高低收量，除權調整）；來源 TradingView → IBKR TWS → Yahoo |
| `POST /api/basket` `{constituents:[{ticker,weight}], range, rebalance, benchmark}` | 自製 ETF 指數（起點 = 100）的日 K、統計、各成分股報酬與貢獻、大盤 ETF 疊圖 |
| `GET /api/quotes/status` / `POST /api/quotes/ib/connect` | TWS 連線狀態 / 立刻重試連線 |
| `POST /api/basket/stream` | 同 `/api/basket`，但以 NDJSON 逐行串流：`start` → 每檔成分股日線一到就一筆 `member`（進度）→ 最後完整的 `series`；body 加 `interim: true` 才會多送約每秒一筆只含已到成分股的暫定 `series`（權重會隨到齊的檔數重算，圖會跳，網頁不用）。關掉連線伺服器就停 |
| `GET /api/quotes/tv-symbol/:ticker` | 財報頁「K 線圖」用的 TradingView 商品代號（`NASDAQ:AAPL`，取自市場快照，避免代號被解析成別國的股票） |

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

### K 線圖

財報頁「股價估值」右邊的「K 線圖」分頁：以 TradingView 官方嵌入圖單獨呈現這檔股票（TradingView 自己的價格、成交量與技術指標；圖上可換週期、加指標、改代號），
區間 1 月 ～ 10 年 / 全部，K 棒紅漲綠跌或綠漲紅跌（與自製 ETF 共用設定），並附「在 TradingView 開啟」連結。商品代號用市場快照裡的交易所代號（`NYSE:BRK.B`），沒有的才交給 TradingView 自行判斷。

### 股價估值

「股價估值」分頁與四張報表、財務指標並列，以所選申報為最後一期：

- **股價來源**：SEC 沒有股價。十年日線走與自製 ETF 相同的鏈 —— TradingView websocket → IBKR TWS → Yahoo（`server/lib/priceSeries.js`），
  打開估值頁時抓一次、快取 30 分鐘，沒有即時報價：「最新」= 最後一根日線的收盤。三個來源的收盤都是分割調整後的，
  但申報書裡的 EPS、股數是當時的數字，所以用 Yahoo 的分割事件（快取一天）把收盤還原成當時的報價，才能算當時的本益比；
  分割事件抓不到時舊價格不還原，頁面會註明。
  現價每 10 分鐘更新、日線快取一天。
- **股價基準**：預設用所選申報的**期末收盤價**（跟各期表一致），可切換成**申報日收盤**（看到財報時的價格）或**現在**的價格，也可自訂；
  倍數、合理價與絕對估值模型都用這個基準價。頁首同時列出三個價格。
- **流通股數**：SEC companyconcept API 的 `dei:EntityCommonStockSharesOutstanding`（申報封面），依 accession 對到各期；
  沒有時用 `us-gaap:CommonStockSharesOutstanding`，再沒有用稀釋加權平均股數。
- **近四季 EPS 跨分割**：各季 EPS 是各自申報書裡的當時數字，四季相加前先把分割前那幾季換到最後一季的股數基準（分割 4:1 就除以 4），不然分割後那三季的本益比會差好幾倍。
- **純前端版**：同一份 [valuation.js](server/lib/valuation.js)（資料來源用 `deps` 注入：伺服器版在 [valuationServer.js](server/lib/valuationServer.js)），股價用隨網站發布的十年日線。沒有封面股數（用稀釋加權平均）、沒有匯率（非美元財報不換算，頁面標示）、沒有分割事件——由各期申報的股數跳動推得（`inferSplits`：相鄰兩期整倍數跳動，2:1 以上或 1:2 以下、誤差 8% 內；3:2 這種抓不到），並在頁面註明是推得的。
- **相對估值法**：本益比、股價淨值比、股價營收比、P/OCF、P/FCF、EV/EBITDA、EV/營收、現金股利殖利率、盈餘殖利率、自由現金流殖利率。
  每一期用「期末收盤價 × 該期近四季數字」，「現在」用現價 × 最近四季；再以歷史平均 / 中位數 / 最低 / 最高倍數 × 目前每股數字反推合理價、便宜價、昂貴價。
- **絕對估值法**（假設可在頁面上改，預設 r 9%、gT 2.5%、N 5 年、g1 = 近幾年營收年複合成長率限 0–15%、稅率 = 近四季有效稅率限 10–30%）：
  自由現金流折現 DCF（兩階段）、股利折現 DDM（兩階段）、剩餘收益模型 RIM、盈餘能力價值 EPV（Greenwald）、
  葛拉漢數字 √(22.5 × EPS × BVPS)、葛拉漢成長公式 EPS × (8.5 + 2g) × 4.4 ÷ Y、每股淨值、每股有形淨值。
  模型公式在 `shared/valuation.js`，伺服器與瀏覽器共用（改假設時瀏覽器直接重算）。
- **外國公司 / ADR**：財報幣別（例如 TSM 的 TWD）與報價幣別不同時，每股數字以 Yahoo 的匯率（各期用期末匯率）換算，
  並乘上頁面上填的 ADR 比率（每 ADR 代表幾股普通股，SEC 資料沒有，TSM 為 5）。

### 觀察名單與評分

- **觀察名單**：財報頁公司名稱旁、分類瀏覽、ETF 成分股與尋找股票表格的 ☆ 可加入；存在瀏覽器的 `localStorage`
  （`stockscan.watchlist`、`stockscan.watchgroups`）。「觀察名單」頁列出每家公司最新財報的評分、五大類分數、最新財報期別與申報日，點列進入財報。
  可自訂**分類**（例如「航運股」，一檔股票可屬於多個分類，不限真正的產業）：左側新增／改名／刪除分類，列上「分類…」勾選，
  左側搜尋框可把公司直接加進目前的分類。
- **尋找股票**：依最新一份已下載財報的指標篩選 —— 產業大類 / SIC 4 碼、申報身分、評分下限，以及任意指標的上下限
  （財務指標表的每一列都能當條件，可加多條），結果依任一欄排序、☆ 加入觀察名單。數字與評分同源（單一申報、年初至今年化），
  金額類以財報幣別的百萬為單位。條件還包括：
  - **市場與估值**（TradingView 市場快照，每半小時更新，`server/lib/market.js`）：股價、總市值、今日／今年／一年漲跌、成交量、Beta、
    本益比、股價淨值比、股價營收比、P/FCF、EV/EBITDA、PEG、殖利率；
  - **報表項目**（最新財報的金額，流量年化）：資產負債表（總資產、流動資產、現金、應收、存貨、PP&E、總負債、流動負債、應付、長期借款、權益）、
    損益表（營收、毛利、研發、銷管、營業利益、利息、稅前、所得稅、淨利、稀釋股數）、現金流量與權益（營業現金流、資本支出、股利、庫藏股買回、發行新股）；
  - **排除產業**：大類點選排除，SIC 用「＋ 排除產業 (SIC)」一列一個可搜尋的選擇框（打代碼、中文或英文名稱都找得到，中文只要字都出現即可，「製藥」會找到「藥品製劑」），可加多列；產業篩選也是同一種選擇框；
  - **與前期比較**：每個條件可選「目前」「較上期」「較去年同期」——比率類比百分點，金額與評分比成長 %。背景爬蟲每家抓最近 5 期財報供比較。
  篩選條件寫在網址裡（`?page=screen&cond=score::60:;grossMargin:yoy:1:&exdiv=H…`），每組條件是一筆瀏覽紀錄，上一頁／書籤都能回到該結果。
  API：`GET /api/screen?division=D&sic=3674&exdiv=H,I&exsic=6770&score_min=60&roe_min=15&revenueAnn_yoy_min=10&price_max=50&marketCap_min=1000000000&sort=marketCap&dir=desc`，
  欄位清單 `GET /api/screen/fields`；`<key>_chg_min/max`、`<key>_yoy_min/max` 為比較條件，`sortmode=chg|yoy` 依變化排序。
- **評分（0–100）**：對一份 10-K / 10-Q 依財務指標的判斷標準計分，五大類各 20 分、平均分給該類的指標：
  財務結構（負債佔資產、長期資金佔 PP&E）、償債能力（流動、速動比率）、經營能力（收現、銷貨日數、完整週期、總資產週轉）、
  獲利能力（毛利率、營益率、淨利率、EPS、ROE）、現金流量（現金流量比率、允當比率、再投資比率、現金佔總資產）。
  達標得滿分、離標準 20% 以內得一半，無法計算的項目不計、總分按剩餘項目換算成 100（`coverage` 表示可計算的分數）；
  可計算的項目不到 50 分（銀行、基金）就不給分數，避免只靠一兩項就得 100。
  為了讓背景爬蟲下載到的每一份財報都能單獨評分，數字全部取自該份申報：期末餘額（平均用比較欄）、各張報表取事實最多的本期欄
  （通常是年初至今）並依其月數 ×12/月數年化，現金流量允當比率也用同一期間而非五年。
  科目對照有多層備援：營業成本認 `CostOfGoodsAndServicesSold`（另列的攤銷會加回）；沒有營業成本科目時，從「營業成本」標題下把管理、
  研發、折舊、減損等間接項目之外的加總；只有「營業費用」這種混合標題、IFRS 的「費用（依性質）」標題、標題下沒有子項（平鋪）或完全沒有標題的報表，
  取營收到營業利益之間的列，只認得出是直接成本的項目（航運的航次／船舶費用、生產成本、佣金、權利金、採購、原物料、燃料、運費、餐廳／門市營運費用、
  保險的理賠與保戶利息、公用事業的燃料與購電…）；營業成本科目只涵蓋一部分業務時（麥當勞的加盟餐廳成本）會再加上旁邊認得出的直接成本列
  （直營餐廳費用）；小計列（金額等於前面各列之和）與營業利益之後的列會跳過；估出來的毛利率若低於 −50% 或低於
  營業利益率就視為抓錯、不顯示。損益表**完全沒有直接成本**、費用只有研發／管理／折舊這類間接項目的（授權型生技、加盟總部）視為毛利率 100%——
  只在有真正營收科目時適用，銀行、保險、投資公司不會被當成 100%；成本列有看不出是直接還是間接的項目時維持不顯示。發行人自訂的 `xxx:CostOfSales`、`xxx:TotalRevenues` 這類只是換個前綴的科目視同標準科目；
  IFRS 的 `RevenueFromSaleOfGoods`、`RevenueAndOperatingIncome`、公用事業與油氣的 `RegulatedOperatingRevenue*`、`OilAndGasRevenue`、
  投資公司（BDC）的總投資收益也算營收（BDC 的營業利益 = 淨投資收益）。沒有應收帳款／應付帳款科目的分類式資產負債表視為 0 天；
  資本支出沒有科目時視為 0（含購買無形資產）；期末與比較期只有一邊有值時用有值的一邊。銀行的營收 = 淨利息收入 + 非利息收入；
  營業利益缺時依序用 營收 − 總成本費用（保險業的 BenefitsLossesAndExpenses 亦然）、毛利（或營收）− 營業費用合計、稅前 − 營業外、
  稅前 + 利息費用 − 利息收入 − 其他營業外；權益／負債總額可由「負債及權益總計」相減；只按產品／服務等單一軸標示、
  沒有合計的科目會把成員加總（但同名的標準科目出現時以它為準）；REIT 的投資性不動產、公用事業的廠房設備視為 PP&E。銀行、保險業沒有流動資產概念，償債、經營能力多半算不出來，分數僅供參考。
- 分類瀏覽與 ETF 成分股表格多了「評分」欄（可排序），顯示每家公司**最新一份已下載財報**的評分；背景爬蟲存好財報後立即計分，
  尚未下載的顯示「—」。財務指標分頁上方有該份申報的評分卡，可展開看每個項目的數值、標準與得分。
- API：`GET /api/score?ciks=320193,1045810` 批次取最新評分；`GET /api/score/:cik/:accession` 取一份申報的完整明細。
  評分存在 `data/store/scores/`（一份財報一檔），`SCORE_VERSION` 變更時啟動會重算。

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
| 經營能力 | 應付款項週轉率 / 平均付款日數 | 年化營業成本 ÷ 平均應付帳款；365 ÷ 週轉率 |
| | 缺現金的天數（現金轉換循環） | 平均銷貨日數 + 平均收現日數 − 平均付款日數；負數代表先收錢再付款 |
| | 做生意的完整週期 | 平均銷貨日數 + 平均收現日數 |
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

### 自製 ETF（K 線）

- 從**尋找股票**的結果（全部或前 N 家）、**觀察名單**的某個分類、**分類瀏覽的 ETF 成分股**（全部或前 N 檔），或自己搜尋加入，
  組成一籃子股票（檔數不限；TradingView 每檔約 0.2 秒，500 檔約一分半）；
  存在瀏覽器的 `localStorage`（`stockscan.baskets`）。
- **ETF 成分的即時來源**（`server/lib/liveHoldings.js`，`GET /api/browse/etf/:ticker/live`，快取 6 小時）：複製 ETF 時不等季報，依序試
  ① 發行商每日持股檔 —— State Street 每檔 SPDR 都有 xlsx（SPY、DIA、MDY、XLK…），② Nasdaq 的指數成分清單（QQQ / QQQM：Nasdaq-100，
  權重以市值近似，QQQ 實際是修正市值加權），③ 追蹤同一指數的 SPDR 檔當替身（IVV / VOO / SPLG → SPY），④ 都沒有才用 N-PORT（季報）。
  iShares 與 Invesco 的持股檔擋在聲明頁後面，抓不到。分類瀏覽的 ETF 表格本身仍是 N-PORT（有市值、股數、對應 CIK）。
- **來源與重新同步**：從 ETF / 尋找股票 / 觀察名單分類複製出來的籃子記得來源，上方有「↻ 重新同步」：重抓來源最新名單與權重 ——
  新增的加進來、來源移除的拿掉、權重更新，並顯示變動摘要。**手動的部分不受影響**：自己搜尋加入的（表格分成「來源成分」「手動新增」兩張）、
  自己改過權重的（標「手動」、欄位變黃，↺ 可改回來源權重；來源已不含但因手動調整而保留的另列一張表）、自己刪掉的來源股（列在最下方的「已排除」表，逐檔或全部還原後會重新同步加回來）。
- **編輯篩選條件**：來源是「尋找股票」的籃子，來源列多一個「✎ 編輯篩選條件」，會帶著原本的條件（網址參數形式，含前 N 家）跳回尋找股票，頁面上標「編輯「某某」的條件」；
  改完條件後可以「更新這個 ETF」（條件與名稱換成新的——名稱沒手動改過才會跟著換——並照重新同步的規則套用新名單，手動加的 / 手動改權重的 / 已排除的都保留）或「建立新 ETF」（另建一個，原本的不動），✕ 取消編輯。
  網址帶 `basket=<id>`，所以上一頁 / 重新整理都還在編輯狀態；從上方「尋找股票」按鈕進來則不是。
  來源權重照比例填滿手動部分之外剩下的空間，合計維持 100%。
  權重欄可直接改（百分比，預設等權重；設 0 就不納入指數但留在名單；合計不是 100% 時依比例換算，表尾有「湊成 100%」）；「買進持有」= 權重是起點那天的配置、之後隨股價漂移，「每日再平衡」= 每天收盤把權重調回設定值。
- **指數**：成分股以起點收盤價換算成持有單位後的加權合計，起點 = 100；日 K 的開高低收各自加權（高低點是各股高低的加權和，會略高估真實區間）。
  區間可選 1 / 3 / 5 / 10 年。資料較晚開始的成分股（IPO）從有資料那天起納入、較早結束的（下市、被收購）最後一天後除名，
  新股由每個部位依它的目標權重比例讓出資金買進、下市股的價金按市值比例分給其餘成分股，其餘部位維持買進持有不再平衡，
  所以單一新股或下市股不會把整張圖縮短；區間內不到 5 天資料的不納入。這些都會註明。
  注意：複製 ETF 拿到的是**最新一份 N-PORT 的權重**，套回一年前買進持有有後見之明偏誤（漲多的股票權重被放大），
  跟該 ETF 真實的同期報酬會差很多，不是資料錯——想知道差距可疊上該 ETF 本身比較。
  從 ETF / 尋找股票 / 觀察名單複製出來的籃子，第一次抓到價格後會**自動移除目前買不到的**（最近兩週沒有成交資料 = 下市、被收購，或每個來源都查無報價），
  其餘權重按比例補回 100%。籃子建立之後才下市的成分股不會被悄悄拿掉：會移到成分表下方獨立的「已下市 / 查無報價」表（註明是最近兩週無報價、還是 EDGAR 代號表已無此代號；
  同一公司改用新代號的會標「已更名為 X」並可一鍵改用新代號），指數只算到它最後有報價那天，表上有「全部移除」。可疊上 SPY / QQQ / DIA / IWM 同期走勢（同樣以起點 = 100），
  下方列出區間報酬、年化報酬、年化波動、最大回撤、最佳／最差單日，表格列出各成分股的起點／最新收盤、區間報酬與貢獻（權重 × 報酬，買進持有時加總 = 指數報酬）。
  表格上方的搜尋框直接加入成分股、每列最右的垃圾桶移除；每列的眼睛可暫時把成分股從指數拿掉（不改權重、不儲存），看 K 線怎麼變；左側清單滑過可改名 / 刪除。
  成交稀少或股價低於 1 美元的成分股標上「低流動性」—— 這類股票單日跳動很大，會扭曲整個指數。
- **日線來源，依序**：① **TradingView** 的圖表 websocket（tradingview.com 自己的圖用的那條，`server/lib/tvws.js`；美股 Cboe One、除權調整；
  一條連線、每檔一個 chart session、同時最多 8 個，30 檔約 3 秒；非官方、無文件，`TV_ENABLED=0` 可關）→ ② IBKR **TWS API**
  （`@stoqey/ib`，`reqHistoricalData` 日線、TRADES；只讀歷史資料、不碰帳戶；TWS 要開 API，10 分鐘 60 次限制）→ ③ Yahoo Finance。
  每檔獨立走這條鏈：前一個來源查不到或逾時就換下一個，表格會標各檔實際來源。裸代號在 TradingView 可能對到別國掛牌（COCO → 印尼），
  所以非美國交易所的結果會改以 NASDAQ / NYSE / AMEX / OTC 前綴重查。
  日線存在 `data/bars/<來源>/<SYMBOL>/`（[barStore.js](server/lib/barStore.js)，格式在 [barFormat.js](server/lib/barFormat.js)），一年一檔：日期存成日差、價格存成相對前一收盤的定點整數再 zstd，是原本 row JSON + brotli 的一半；
  已結束的年份（`<年>.zst`）和 `meta.json` 進 data ref、寫完就不再動；今年的 bars 在 `head.zst`，每次更新都重寫，所以不進 git——取回 data ref 有到去年底的十年，今年的部分由 server 的背景抓取或 Pages 的 workflow 補。跨年時第一次寫入會把 head 封成 `<年>.zst`（meta 的 `years` 多一年），workflow 下一次 push data ref 就會帶上。盤中 30 分鐘內視為新鮮；收盤後抓的一直有效到下一個交易日開盤（日線在收盤後不會變），所以晚上、週末重開同一個 ETF 完全不打網路；
  最近讀過的 400 檔解碼後留在記憶體，同一個籃子連開是 0 ms。過期時**只抓最後一根之後的幾天**（往前多抓 7 天核對）接上去，不重抓整段 10 年——三個來源都支援（TradingView 指定根數、TWS 指定天數、Yahoo 指定起日）；
  盤中停機存下的最後一根還沒收完，重開時允許它跟核對段不同（只重寫那一年）。核對段對不上（期間發生分割）才整段重抓，但重抓回來**不改歷史檔**：整段差一個固定倍數就在 `meta.json` 的 `adjust` 記一筆 `{ date, price, volume }`，讀的時候把該日之前的價量乘上去；
  只有對不成一個倍數的資料修訂才重寫牽涉到的那幾年。一個月沒人讀的檔啟動時清掉。
  另有背景抓取（[barCrawler.js](server/lib/barCrawler.js)）：每個交易日紐約收盤後半小時，把代號表上每一檔的 TradingView 日線補到最新——第一次看到的代號抓十年（約 30 KB），之後每天只抓最後一根之後的幾根；
  6 條並發約每秒 11 檔，一萬多檔一輪約 16 分鐘。TradingView 查不到的代號（多是 OTC 的外國股）連續三次失敗後隔一週再試。`/api/status` 的 `barCrawler` 看進度；`npm run fetch:bars` 手動跑一輪就結束（workflow 用這個）。
  純前端版（GitHub Pages）也有日線：build 把 `data/bars` 一起放進站台，自製 ETF 頁在瀏覽器裡解 zstd、套分割調整、算指數（[basket.js](server/lib/basket.js) 前後端共用），資料到排程最後一次抓的交易日、不連外部服務。有快取的成分股不會去探測 TWS（TWS 沒開時探測一次要等 1.5 秒，且結果記一分鐘）。股價估值頁也走同一條鏈（見「股價估值」）。
- **K 線圖（預設：Advanced Charts）**：伺服器把各成分股日線組成指數後餵給 TradingView 授權版 **Advanced Charts**
  （`charting_library` 放在 `web/assets/tradingview/`，後端以 `/tradingview/` 提供、Vite 開發模式代理過去；資料由 `web/src/tvDatafeed.js`
  以 Datafeed API 餵入，大盤 ETF 以 Overlay 指標疊同一價格軸，週／月線由函式庫從日線合成），沒有這個資料夾時用開源的
  [Lightweight Charts](https://github.com/tradingview/lightweight-charts)。成分股數不限（websocket 逐檔抓、自己加總，等同把多個價差商品相加）。
- **K 線圖（備用：TradingView widget）**：切換「圖：TradingView widget」，用 TradingView 官方嵌入式 Advanced Chart widget，
  成分股組成**價差商品**（如 `0.1678*AAPL+0.1731*GOOGL+…`，係數 = 起點時的持有單位、起點 = 100），TradingView 逐根算開高低收，
  大盤 ETF 以 `compareSymbols` 同軸比較。限制：一個價差商品**最多 10 檔**（超過自動改回 Advanced Charts）、只能買進持有、
  區間 1 / 3 / 5 / 10 年對應 12M / 36M / 61M / 120M（60M 是 TradingView 預設值會改成週線）。預設紅漲綠跌，可切換。
- 所有搜尋框（頁首、觀察名單、自製 ETF）的建議清單都顯示該公司最新財報的評分（`GET /api/search` 每筆附 `score`）。

## 專案結構

| 檔案 | 內容 |
|---|---|
| `server/index.js` | Express 路由、靜態檔案 |
| `server/lib/secClient.js` | sec.gov HTTP client：User-Agent、10 req/s 限速、重試、高/低優先權（預抓讓路） |
| `server/lib/filings.js`、`statementTypes.js`、`storeFormat.js`、`scoreModel.js`、`screen.js`、`marketFields.js`、`sic.js` | 純計算 / 純資料模組（無 Node I/O），伺服器與純前端版共用：申報清單工具、報表分類、存檔格式還原、評分模型、尋找股票與分類瀏覽的篩選排序、市場欄位、SIC 表 |
| `server/tools/build-static.mjs`、`fetch-new.mjs` | 產生純前端版（`npm run build:static`）；一次性抓最近幾天的新申報（`npm run fetch:new`，排程用） |
| `tools/stockscan-static/` | Rust：靜態版 build 的重活（`copy` 平行複製／hard link、`decode` 平行解開 store 取每份財報表頭與評分、`compress` 多執行緒 zstd）；索引的內容仍由 build-static.mjs 決定，兩條路輸出相同 |
| `web/src/api.js`、`api.http.js`、`api.static.js`、`api.static.worker.js`、`staticData.js` | 前端資料層：dispatcher、打 `/api` 的實作、純前端實作（頁面上的 proxy 與做事的 Web Worker：讀靜態檔 + 瀏覽器內計算、WASM zstd） |
| `server/lib/barStore.js` | 日線快取：一檔一個 brotli 檔、記憶體 LRU、增量接續（`mergeDays` 核對重疊段）、一個月未用清除；舊 kv 裡的日線第一次啟動會搬過來 |
| `server/lib/store.js` | 存檔：`data/store/` 的財報 / 評分小檔（brotli JSON、檔名帶 cik / 期末 / 表別 / 版本，啟動時掃檔名建索引）、`data/cache.sqlite` 的 kv 快取、舊版 SQLite 的一次性搬移 |
| `server/lib/prefetch.js` | 閒置時背景預抓相鄰申報 |
| `server/lib/crawler.js` | 背景爬蟲：掃過所有有代號公司的最近 5 期申報，並每 30 分鐘監看 EDGAR daily index |
| `server/lib/market.js` | TradingView 市場快照：全美股的股價、市值、估值倍數、成交量（每半小時） |
| `server/lib/edgar.js` | ticker/CIK → 公司與申報清單、會計年度/季度判斷、`ix?doc=` 網址解析 |
| `server/lib/ixbrl.js` | 解析 iXBRL：contexts、units、`ix:nonFraction` / `ix:nonNumeric`、ixt 數值與日期轉換 |
| `server/lib/taxonomy.js` | 解析 `.xsd` role 定義、presentation linkbase、label linkbase（支援 linkbase 內嵌在 xsd 的申報） |
| `server/lib/statements.js` | 把事實依 presentation tree 組成報表，篩選維度、去除雜欄 |
| `server/lib/scrape.js` | 一份申報 → 完整 JSON（含 MetaLinks.json 的標準名稱與定義） |
| `server/lib/zh.js`、`zh-more.js`、`zh-batch3.js` | 科目中文對照表（標準科目、說明、大型公司自訂科目、多家共用的自訂科目名稱、拼法變體比對）；`applyZh` 在讀取存檔時補上 |
| `server/lib/current.js` | 「只看本期」檢視：去掉比較欄，現金流量表以年初至今相減得本季 |
| `server/lib/quarters.js` | 季度拆分與 Q4 推算；`yearQuarterPoints` 供指標頁使用 |
| `server/lib/indicators.js` | 財務指標（五大比率）計算 |
| `server/lib/prices.js` | Yahoo Finance 日線與匯率（估值頁的匯率仍用它） |
| `server/lib/priceSeries.js` | 估值頁的股價：日線走 TradingView → IBKR → Yahoo，附 Yahoo 分割事件（valuation.js 用它還原成當時報價） |
| `server/lib/tvws.js` | TradingView 圖表 websocket：日線（含價差商品） |
| `server/lib/ib.js` | IBKR TWS API 連線與日線（`@stoqey/ib`） |
| `server/lib/bars.js` | 日 K（TradingView → IBKR → Yahoo）與自製 ETF 指數、統計 |
| `server/lib/valuation.js`、`valuationServer.js` | 估值：近四季數字、股數、各期倍數、絕對模型輸入（純計算，資料來源注入；伺服器與純前端版共用）；伺服器的資料來源（SEC 封面股數、日線、Yahoo 匯率） |
| `shared/valuation.js` | 估值模型與倍數公式（伺服器與瀏覽器共用） |
| `server/lib/score.js` | 單一申報的評分（五大類 × 20 分） |
| `server/lib/universe.js` | 全部申報公司的 SIC / 申報身分 / 公眾流通市值（Financial Statement Data Sets + frames API） |
| `server/lib/etf.js` | ETF 清單、N-PORT 成分股、CUSIP → 代號 → CIK 對應 |
| `server/lib/liveHoldings.js` | ETF 最新成分：SPDR 每日持股 xlsx、Nasdaq 指數成分、同指數替身，否則 N-PORT |
| `server/lib/remoteZip.js` | 用 HTTP Range 從 sec.gov 的 zip 只抽出需要的檔案 |
| `server/data/sic.json` | SIC 4 碼對照表（SEC 英文名、中文名、大類） |
| `web/` | Vue 3 + Vite 前端（`CompanySearch`、`FilingPicker`、`StatementTable`、`IndicatorsTable`、`BrowsePage`、`CompanyTable`、`ValuationPanel`、`WatchlistPage`、`ScreenerPage`、`BasketPage`、`KlineChart`、`TvEmbedChart`、`Icon`、`ScoreCard`、`ScoreBadge`；`watchlist.js` / `baskets.js` 為 localStorage 觀察名單 / 自製 ETF；`tvDatafeed.js` 供 TradingView Advanced Charts；`assets/tradingview/` 放授權的 charting_library） |
