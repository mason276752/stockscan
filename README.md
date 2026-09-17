# stockscan `data` branch

`main` 只有程式碼；財報、評分、申報清單（`data/store/`）與全市場已結束年份的日線（`data/bars/`）都在這個 branch，
由 GitHub Actions（`.github/workflows/pages.yml`）在排程抓到新申報後多 commit 一個推上來（獨立的歷史，跟 `main` 沒有共同祖先；
每個 commit 都接在前一個後面——git 只送父 commit 沒有的物件，孤兒 commit 會把整個 600 MB 重送一次）。

本機要跑伺服器版、或在本機 `npm run build:static`，把資料放進工作目錄（`main` 的 `.gitignore` 忽略 `data/`，所以不會被誤 commit）：

```bash
git fetch --depth=1 origin data
git restore --source=FETCH_HEAD -- data/store data/bars
```

不要把這個 branch merge 進 `main`。
