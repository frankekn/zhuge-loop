# Team Composition

zhuge-loop 的五位武將角色模板，對應軟體工程的五個核心職能。

---

## 角色總覽

| Name | Chinese Name | Role | Tagline | Engineering Mapping |
|------|-------------|------|---------|-------------------|
| zhuge | 諸葛亮 | coordinator | 拆任務、定方向、預見風險 | Tech Lead / Project Manager — 負責拆解需求、排優先順序、產出 plan 檔 |
| zhaoyun | 趙雲 | executor | 可靠交付每一行 | Software Engineer — 根據 plan 寫程式碼、跑測試、提交 commit |
| guanyu | 關羽 | reviewer | 品質不妥協 | Code Reviewer / QA — 審查變更、檢查安全與風格、產出 review 檔 |
| zhangfei | 張飛 | breaker | 破瓶頸、獵 Bug | Debugger / SRE — 處理難解 bug、flaky test、技術債 |
| caocao | 曹操 | automator | 極致執行 | DevOps / Platform Engineer — CI/CD、build script、自動化工作流 |

---

## Solo Mode vs Team Mode

### Solo Mode

單一 profile 包含所有 phase，由同一個 agent 從頭做到尾。

```json
{
  "profileRotation": ["default"],
  "profiles": {
    "default": {
      "phases": [
        { "id": "plan",      "command": "..." },
        { "id": "implement", "command": "..." },
        { "id": "verify",    "command": "..." }
      ]
    }
  }
}
```

適用場景：
- 專案初期，工作範圍小。
- 只有一個 agent 可用。
- 不需要獨立的 code review 階段。

### Team Mode

多個 profile 各自對應一位武將，透過 `profileRotation` 輪替執行。每個 turn 只執行一個 profile。

```json
{
  "profileRotation": ["zhuge", "zhaoyun", "guanyu"],
  "profiles": {
    "zhuge":   { "phases": [{ "id": "plan",     "command": "..." }] },
    "zhaoyun": { "phases": [{ "id": "implement","command": "..." }, { "id": "test", "command": "..." }] },
    "guanyu":  { "phases": [{ "id": "review",   "command": "..." }] }
  }
}
```

適用場景：
- 需要獨立的規劃、實作、審查階段。
- 希望不同階段使用不同的 system prompt 或工具集。
- 多人團隊需要明確的職責分離。

---

## Rotation 機制

zhuge-loop 使用 `profileRotation` 陣列控制每個 turn 執行哪個 profile。機制是 round-robin：

```
profileRotation: ["zhuge", "zhaoyun", "guanyu"]

Turn 0 → zhuge    (plan)
Turn 1 → zhaoyun  (implement)
Turn 2 → guanyu   (review)
Turn 3 → zhuge    (plan)       ← 回到開頭
Turn 4 → zhaoyun  (implement)
...
```

計算方式：`profileRotation[turnNumber % profileRotation.length]`

### 進階用法

同一個 profile 可以出現多次，調整權重：

```json
"profileRotation": ["zhuge", "zhaoyun", "zhaoyun", "guanyu"]
```

上例中 executor 每輪出現兩次，適合實作比重較大的階段。

也可以在需要時加入 breaker 或 automator：

```json
"profileRotation": ["zhuge", "zhaoyun", "guanyu", "zhaoyun", "zhangfei"]
```

每五個 turn 安排一次 debug/穩定化巡檢。

---

## 角色模板位置

每位武將的 system prompt 模板位於：

```
starters/agents/
  zhuge.json       # coordinator
  zhaoyun.json     # executor
  guanyu.json      # reviewer
  zhangfei.json    # breaker
  caocao.json      # automator
```

使用時將 `promptTemplate` 欄位的內容作為 agent 的 system prompt，搭配 `tools` 欄位指定可用工具。

---

## 注意事項

- 角色模板是 **起始點**，不是限制。根據專案需求調整 prompt 和工具清單。
- Coordinator (zhuge) 和 Reviewer (guanyu) 的工具集不包含 `write`，這是刻意的 — 它們不應該修改原始碼。
- Breaker (zhangfei) 有 `write` 權限，因為修 bug 需要改程式碼。
- Automator (caocao) 有 `write` 權限，因為需要建立 script 和 CI 設定檔。
- 五位武將不一定要全部使用。最常見的組合是三人 (zhuge + zhaoyun + guanyu)。
