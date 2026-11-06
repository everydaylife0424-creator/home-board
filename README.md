# HOME

Adam 的個人效率網站，包含待辦、健身計劃、每日檢討和記帳。

- 線上版本：https://claude.ai/artifact/5hwVWihuHWRrGUc7G9tLpP （只有本人登入後看得到）
- 所有程式都在 `index.html` 這一個檔案裡。

## 改網頁上的文字

方法一：在網頁上直接改。打開左側目錄的「編輯文字」，點任何標題或灰色小字就能修改，按 Enter 儲存，清空會恢復預設。這樣改的內容存在資料庫，不會動到程式碼。

方法二：改程式碼。打開 `index.html`，搜尋 `const I18N`，裡面的 `zh` 是中文、`en` 是英文，每一行是一段文字，例如：

```js
tasks_sub:"依急迫程度分類 · 可拖曳換欄",
```

只改引號裡的字就好。寫成 `(a, b) => \`...\`` 的是會帶入數字或日期的句子，`${...}` 的部分保留不要刪。

## 更新線上版本

線上版本是 Claude 的 Artifact，用到 Claude 提供的雲端資料庫，所以不能直接放到 GitHub Pages 上跑。改完 `index.html` 後，請 Claude 依照這個 repo 的最新版本重新發布到同一個連結。

## 桌布

`bg/` 裡是 Adam 提供的 5 張 Pexels 照片（原圖畫質，`bg/t/` 是圖庫縮圖），網頁上方可以換，也可以上傳自己的照片。每張圖的主色寫在 `index.html` 的 `WPS` 清單裡（hue、sat），整頁淡色調就是從這裡算出來的。

## 資料存在哪裡

資料不在這個 repo 裡，存在 Artifact 的資料庫：

| 集合 | 內容 |
| --- | --- |
| `tasks/<id>` | 任務板上的任務：標題、分欄、截止日、是否完成、完成時間 |
| `days/<YYYY-MM-DD>` | 每天的 to-do、專案進度、檢討、心情。勾選時會記下完成日 `dn` |
| `expenses/<YYYY-MM>` | 每月記帳明細 |
| `events/<id>` | 月曆上的截止日與重大事件（kind：deadline / event） |
| `gym/plan` | 健身課表：課表 → 分組 → 動作（目標、備註） |
| `gymlog/<YYYY-MM>` | 每月健身紀錄：日期、動作、組×次、重量、RPE |
| `settings/main` | 專案清單、每天自動出現的專案、記帳分類、在網頁上改過的文字 `texts` |
