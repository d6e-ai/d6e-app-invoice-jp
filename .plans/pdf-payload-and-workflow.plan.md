# PDF payload 受け取り・ワークフロー連携・入力形式統一の修正プラン

Relates to: d6e-ai/d6e-app-invoice-jp#5

## 目的

v1.0.0 の end-to-end テストで確認された、以下の不具合をすべて解消する。

- `render-invoice-pdf` が空 / ¥0 の PDF を生成してしまう
- PDF ファイル名が `適格請求書_undated.pdf` になり書類番号が反映されない
- AI が想定していた `generate-invoice-files` ワークフローが実は存在しない
- 3 STF の入力形式（`$input` / ラップ形式）がケースによってずれ、エージェントがワークアラウンドで凌いでいる

## 前提

d6e ランタイムの仕様を `packages/api/src/engine/runtime_js.rs` と
`packages/api/src/engine/{workflow,context,input_resolver}.rs` で確認済み。

- `$input` は STF 実行時にランタイムが直接 `globalThis.$input` にセットする（`runtime_js.rs` L717-721）。
- ワークフローは `input_steps` → `stf_steps`（順次） → `effect_steps`（並列）で実行される（`workflow.rs` L49-119）。
- field mapping のパスは `$input.xxx` / `$steps[n].xxx` / `$sources.name.xxx` のいずれかの **`$` プレフィックス必須** 形式（`context.rs` L45-80、`packages/skills/d6e-workflow/SKILL.md` L77 で明記）。
- installer はマッピングの `value` を変換せずそのまま API に渡す（`packages/frontend/src/lib/server/app-installer.ts` L504-507）。

## 変更点

### 1. `template.yaml`

- **`validate-qualified-invoice` の input_schema** を単一の権威定義とし、`render-invoice-pdf` / `render-invoice-docx` の input_schema にも同じ完全形スキーマをコピーして揃える。
  - 3 箇所のコピーを維持する必要があるので、各 STF の直上に `# Keep this schema in sync with validate-qualified-invoice.` というコメントを置いて、将来のズレを防ぐ。
  - `required` は validate と同じ `[document_type, transaction_date, issuer, items]` のまま。
- **`workflows:` ブロックを追加**し、以下 2 本のワークフローを定義する。`d6e` の `execute_workflow` は最後の STF 出力のみを戻り値として返し、`binary-detection.ts` の `extractBinaryFromResult` も 1 つの `file_data` しか抽出できない。単一ワークフローで PDF と DOCX を同時に返すことは現状の API / UI では実現不可能。よって、**ユーザーが欲しい形式ごとに独立したワークフローを提供**し、AI がそれらを順次呼び分ける形にする。
  - `generate-invoice-pdf`: validate-qualified-invoice → render-invoice-pdf（last step → PDF の `{file_data, file_name}` が戻り値）。
  - `generate-invoice-docx`: validate-qualified-invoice → render-invoice-docx（last step → DOCX の `{file_data, file_name}` が戻り値）。
  - 両ワークフローとも step 0 の `input_mappings` は `$input.<field>` を 13 個（全フィールド）。step 1 の `input_mappings` は `$steps[0].normalized_payload.<field>` を 13 個。
  - validate が失敗（`$steps[0].valid === false`）した場合、render step にはエラー時の `normalized_payload: null` が渡るので、render STF 側で payload が空オブジェクトに近い状態になる。このケースは AI がワークフロー実行前に直接 validate を一度呼んでエラーを提示するのが理想。`template_prompt` で明示する。
- **`template_prompt`** を以下のように書き換える。
  - これまでの「validate を呼んで、normalized_payload を render に渡す」手続き指示を外し、**ワークフロー呼び出しを第一選択**にする。
  - 両方の形式（PDF + DOCX）が欲しい場合は **事前に `validate-qualified-invoice` を 1 回だけ単体実行** してエラーをユーザーに提示 → 問題なければ `generate-invoice-pdf` と `generate-invoice-docx` を**両方**呼ぶ、という流れを明示する。validate を単体で先に呼ぶことで、万が一エラーがあっても不要な PDF / DOCX 生成を回避でき、かつ2 本のワークフローで validate が二重に走ることのオーバーヘッドも「エラー無しが確認済み」なので許容できる範囲に収まる。
  - PDF だけ（または DOCX だけ）欲しい場合は対応するワークフローを 1 本だけ呼ぶ。
  - 直接 STF を手動で連結する呼び出し方はフォールバックとして残すが、第一推奨からは外す。

### 2. `stfs/render-invoice-pdf.js`

- **ファイル名生成ロジック** を以下の優先順位に変更する。
  1. `payload.document_number` があり、サニタイズ後も長さ > 0 ならそれを採用
  2. なければ `payload.transaction_date`（`YYYY-MM-DD` → `YYYYMMDD`）
  3. それも無ければ `payload.issue_date` を同様に整形
  4. どれも無ければ `'undated'`
- **サニタイズ** は `/[\\/:*?"<>|\\s]/g` を `_` に置換し、連続アンダーバーをつぶす。さらに先頭末尾の `_` を trim して、最大 80 文字に切り詰める。
- **payload unwrap フォールバック** を追加する。
  - `$input.normalized_payload` が オブジェクトなら `payload = $input.normalized_payload` にする（AI が validate の戻り値をそのまま投げたケース）。
  - ワークフローからの呼び出しでは input_mappings が直接 payload フィールドを並べるので、このフォールバックは通らない。
- これらの変更は `// --- input resolution ---` セクションに集約し、コメントで「ワークフロー経由 / 手動呼び出しの両方に対応」と明記する。

### 3. `stfs/render-invoice-docx.js`

- PDF と**同一**のファイル名生成 / payload unwrap ロジックに置き換える。共通関数は抽出できない（STF は1ファイル1実行単位）ので、両ファイルに同じ実装をコピーし、コメントで「render-invoice-pdf.js と同期させる」と明記。

### 4. `stfs/validate-qualified-invoice.js`

- 現状は `$input` から直接受け取って `normalized_payload` を返している。ワークフロー内でも `$input.xxx` から直接フィールドが渡されるため、修正不要。
- 念のため、`$input.normalized_payload`  ラップで来た場合も対応する同じ unwrap フォールバックを入れる（対称性のため）。

### 5. `README.md` / `CHANGELOG.md`

- README の「使い方」セクションに `generate-invoice-files` ワークフローが第一推奨であることを追記。
- CHANGELOG の Unreleased v1.0.0 に以下を追記:
  - Fixed: PDF payload not being received
  - Fixed: filename falling back to `undated` even when document_number exists
  - Added: `generate-invoice-files` workflow
  - Changed: render STF input_schema expanded to full payload shape

## 検証

- `/tmp/d6e-validate/check-stfs.js` で 3 STF の構文を再チェック。
- `ajv` で template.yaml を template.schema.json に対して再検証（既に存在する流れを再利用）。
- 手元で validate STF に「テスト payload（書類番号 `INV-TEST-20260422-004`、取引日 `2026-04-22`）」を `$input` として渡して `normalized_payload` が想定通りのものを返すか、Node 単体実行で簡易確認（STF コードを import 剥がして wrapper で包む形）。

## 非スコープ

以下は本 Issue では扱わない。

- simplified_invoice / return_invoice のテスト実施そのもの（本修正後に別タスクで再テスト）。
- ワークフロー戻り値に全 step 出力を含める機能強化（d6e 本体側の話）。
- workflow の step 並列実行化（`workflow.rs` の STF 並列化改修）。
