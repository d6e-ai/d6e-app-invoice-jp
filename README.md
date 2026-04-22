# d6e-app-invoice-jp

[日本語版はこちら](#日本語版) ／ [English below](#english)

---

## 日本語版

日本の**インボイス制度（適格請求書等保存方式）**に準拠した帳票を、
d6e のチャットから **PDF** と **Word (docx)** の両方で生成・検証できる d6e App です。

次の 3 種類の帳票を 1 つの App でカバーします。

| `document_type`       | 帳票名           | 用途                                                   |
| --------------------- | ---------------- | ------------------------------------------------------ |
| `qualified_invoice`   | 適格請求書       | 通常の BtoB 取引で仕入税額控除の根拠となる請求書。     |
| `simplified_invoice`  | 適格簡易請求書   | 小売・飲食・タクシー等の不特定多数を相手にする業種。   |
| `return_invoice`      | 適格返還請求書   | 値引き・返品等で対価を返還した際に発行する請求書。     |

### 実装されている検証項目

国税庁およびインボイス制度の解説記事を参考に、以下を **毎回自動で検証** します。

- 適格請求書の **6 記載要件** がすべて揃っているか
  1. 適格請求書発行事業者の氏名または名称
  2. 登録番号（`T` + 13 桁）
  3. 取引年月日
  4. 取引内容（軽減税率対象品目である旨を含む）
  5. 税率ごとに区分して合計した対価の額 / 適用税率
  6. 税率ごとに区分した消費税額等
  7. 書類の交付を受ける事業者の氏名または名称（簡易インボイスは任意）
- **登録番号の形式**（`/^T\d{13}$/`）
- **端数処理ルール**：1 枚の適格請求書につき税率ごとに 1 回のみ
- 帳票タイプ別の必須項目（返還インボイスでは「返還事由」「対象となる元請求書番号」が必須）

### 使い方（3 モード）

本 App は、d6e のチャットから次の 3 通りで呼び出せます。
どのモードでも、内部では同じ 3 つの STF が走ります。

1. **JSON ペーストモード（推奨）**
   - 自社システム等で組み立てた JSON をコードブロックで貼り付けて依頼する使い方です。
   - 例：「このデータで適格請求書を作って」と書き、本 README 内の入力 JSON をそのまま貼り付けます。
2. **テンプレ要求モード**
   - 「雛形を教えて」「入力フォーマットは？」と聞くと、
     AI が `files/invoice-input-template.json` の該当 `document_type` ブロックを返します。
   - 返ってきたブロックを自社情報で編集して、1. の JSON ペーストで投入してください。
3. **対話フォールバックモード**
   - 「ABC 商店向けの請求書を作って」のような自然文の依頼に対し、AI が 6 記載要件に必要な項目を
     ひとつずつ質問して埋めていきます。JSON を用意できない利用者向けのフォールバックです。

### 入力 JSON の完全例

以下の JSON をチャットに貼り付けると、適格請求書 1 枚分の PDF と DOCX が生成されます。
値はすべてお客様の情報に置き換えて使用してください。

```json
{
  "document_type": "qualified_invoice",
  "document_number": "INV-2026-0421-001",
  "transaction_date": "2026-04-21",
  "issue_date": "2026-04-21",
  "issuer": {
    "name": "株式会社サンプル商事",
    "registration_number": "T1234567890123",
    "address": "東京都品川区大崎1-2-3 サンプルビル 5F",
    "contact": "TEL: 03-1234-5678 / invoice@example.co.jp",
    "logo": null
  },
  "recipient": {
    "name": "ABC商店 御中",
    "address": "東京都渋谷区道玄坂1-1-1"
  },
  "items": [
    { "description": "ノートパソコン A", "quantity": 2,  "unit_price": 89800, "tax_rate": 0.10 },
    { "description": "ワイヤレスマウス", "quantity": 5,  "unit_price": 2980,  "tax_rate": 0.10 },
    { "description": "会議用弁当",       "quantity": 10, "unit_price": 800,   "tax_rate": 0.08 }
  ],
  "price_mode": "tax_excluded",
  "rounding_method": "floor",
  "payment": {
    "due_date": "2026-05-31",
    "bank_info": "〇〇銀行 品川支店 普通 1234567 カ)サンプルシヨウジ"
  },
  "notes": "振込手数料は貴社ご負担にてお願い申し上げます。"
}
```

### フィールドリファレンス

| フィールド                        | 型                         | 必須                | 説明                                                          |
| --------------------------------- | -------------------------- | ------------------- | ------------------------------------------------------------- |
| `document_type`                   | string                     | 必須                | `qualified_invoice` / `simplified_invoice` / `return_invoice` |
| `document_number`                 | string                     | 任意                | 省略時は `YYYYMMDD-RRRRRR` で自動採番されます。               |
| `transaction_date`                | string (`YYYY-MM-DD`)      | 必須                | 取引年月日。                                                  |
| `issue_date`                      | string (`YYYY-MM-DD`)      | 任意                | 省略時は `transaction_date` と同じ扱いです。                  |
| `issuer.name`                     | string                     | 必須                | 発行事業者の氏名または名称。                                  |
| `issuer.registration_number`      | string (`T` + 13 桁)       | 必須                | 正規表現 `/^T\d{13}$/` で検証します。                         |
| `issuer.address`                  | string                     | 任意                | 住所。                                                        |
| `issuer.contact`                  | string                     | 任意                | 電話番号・メールアドレス等の連絡先。                          |
| `issuer.logo`                     | object \| null             | 任意                | 会社ロゴ。`{ format, data_base64 }`。null または省略で非表示。|
| `recipient.name`                  | string                     | 必須 (簡易は任意)   | 書類の交付を受ける事業者の氏名または名称。                    |
| `recipient.address`               | string                     | 任意                | 受領事業者の住所。                                            |
| `items[].description`             | string                     | 必須                | 品目名。                                                      |
| `items[].quantity`                | number                     | 必須                | 数量。                                                        |
| `items[].unit_price`              | number                     | 必須                | 単価 (`price_mode` により税抜／税込)。                        |
| `items[].tax_rate`                | number                     | 必須                | `0.10` (標準) または `0.08` (軽減)。                          |
| `price_mode`                      | `tax_excluded` \| `tax_included` | 任意          | 既定値 `tax_excluded` (税抜表示)。                            |
| `rounding_method`                 | `floor` \| `ceil` \| `round` | 任意              | 税率ごとの合計消費税額の端数処理。既定値 `floor` (切り捨て)。 |
| `payment.due_date`                | string (`YYYY-MM-DD`)      | 任意                | 支払期限。                                                    |
| `payment.bank_info`               | string                     | 任意                | 振込先情報。                                                  |
| `notes`                           | string                     | 任意                | 備考欄に表示されます。                                        |
| `return_info.reason`              | string                     | 必須 (返還時)       | 返還事由。                                                    |
| `return_info.original_document_number` | string                | 必須 (返還時)       | 返還対象の元請求書番号。                                      |
| `return_info.return_date`         | string (`YYYY-MM-DD`)      | 任意                | 返還日。                                                      |

### ロゴ画像の差し替え手順

`issuer.logo.data_base64` に PNG / JPEG を base64 エンコードした文字列を指定すると、
帳票ヘッダーにロゴが埋め込まれます (最大 120 × 48pt にアスペクト比を保ったまま収まります)。

```bash
# Linux
base64 -w 0 logo.png > logo.b64

# macOS
base64 -i logo.png -o logo.b64
```

生成された `logo.b64` の中身をチャットに貼り付ける JSON の
`issuer.logo` に次のように差し込んでください。

```json
"logo": {
  "format": "png",
  "data_base64": "iVBORw0KGgoAAAANSUhEUgAA... (長い base64 文字列)"
}
```

### v1.0.0 の既知の制限事項

- **PDF の明細行数**: 1 枚の A4 PDF に収まる範囲でのみ明細を描画します。
  明細件数が上限を超えた場合は、PDF 本体に
  「※ 明細は紙面の都合で先頭 N 行のみ表示しています」
  と注記が入ります（DOCX は自動改ページされるため影響ありません）。
  多ページ PDF への対応は次バージョン以降を予定しています。
- **ロゴサイズ**: 印字範囲は最大 140 × 56pt (PDF) / 140 × 56px (DOCX) に
  アスペクト比を保ったまま収まります。大きな画像を渡すと自動で縮小表示されます。

### インストール

d6e Marketplace の Apps タブからインストールしてください。
Verified App として承認されると、Apps タブで緑色のバッジ付きで検索できるようになります。

### ライセンス

MIT License. 詳細は [LICENSE](./LICENSE) を参照してください。

---

## English

A d6e App that generates Japan's **qualified invoice (適格請求書)** documents
in both **PDF** and **Word (docx)** formats, fully compliant with the Japanese
Invoice System (インボイス制度 / Qualified Invoice Method).

This single App supports three related document types.

| `document_type`       | Document                         | Use case                                                   |
| --------------------- | -------------------------------- | ---------------------------------------------------------- |
| `qualified_invoice`   | Qualified Invoice                | Standard B2B invoice for input tax credit.                 |
| `simplified_invoice`  | Simplified Qualified Invoice     | Retail, food service, taxi, parking, etc.                  |
| `return_invoice`      | Qualified Return Invoice         | Discounts, refunds, and returned goods.                    |

### Built-in validations

On every request, the App automatically validates the Japanese Invoice System's
**six mandatory fields**, registration number format (`T` + 13 digits), and
tax-rounding rules (exactly one rounding operation per tax bracket per invoice).

### Three ways to use

1. **JSON paste (recommended)** – Paste a fully-formed JSON object into the chat.
2. **Template request** – Ask for the input template; the AI returns the matching
   block from `files/invoice-input-template.json` for you to edit.
3. **Interactive fallback** – Ask in natural language; the AI asks follow-up
   questions to fill in the six mandatory fields.

See the Japanese section above for a complete JSON example, field reference, and
logo embedding instructions. All field names and JSON keys are identical in both
languages; only rendered text on the generated documents is in Japanese.

### License

MIT License. See [LICENSE](./LICENSE) for details.
