# Zhuge Loop Methodology

## English

### 1. One turn, one shippable slice

A turn should produce one smallest useful change that can be verified automatically.
Avoid batching unrelated work in one turn.

### 2. Verification is mandatory

Every turn must include machine-verifiable checks:

- unit/integration tests
- build checks
- contract checks

If verification cannot be automated, skip that acceptance point and move to automatable scope.

### 3. Orchestrator owns reliability

Reliability concerns belong to the loop runtime, not ad-hoc shell scripts:

- single-instance lock
- stale lock cleanup
- timeout + process-group kill
- failure fuse and halt log

### 4. Keep the UI layer out of domain logic

When used in app projects, UI should format and join only.
Domain rules should stay in worker/core contracts.

### 5. Recovery over heroics

Do not rely on manual babysitting.
The system should either:

- recover automatically, or
- halt clearly with enough logs for deterministic recovery.

## 中文

### 1. 一輪只做一個可交付切片

每一輪都要有可驗證、可落地的最小成果，不要把多個不相關的大改綁在同一輪。

### 2. 驗證必須自動化

每輪都要有自動化檢查（測試、build、contract）。
不能自動驗證的驗收點，直接跳過，去做可自動驗證的功能。

### 3. 穩定性責任在 orchestrator

鎖、超時、熔斷、恢復這些機制要在 loop 引擎內建，不要散落在臨時腳本。

### 4. UI 不要承擔業務規則

UI 只做 join/format，業務公式與規則由 domain/worker 合約輸出。

### 5. 追求可恢復，不靠人盯盤

理想狀態是：能自動恢復就自動恢復，不能恢復就明確熔斷並留下足夠日誌。
