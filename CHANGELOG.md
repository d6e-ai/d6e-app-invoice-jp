# Changelog

All notable changes to this d6e App are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.0.0] - Unreleased

### Added

- Initial release of `d6e/invoice-jp`.
- Support for three Japanese Invoice System document types:
  - `qualified_invoice` (適格請求書)
  - `simplified_invoice` (適格簡易請求書)
  - `return_invoice` (適格返還請求書)
- STF `validate-qualified-invoice` for six-field and registration-number validation.
- STF `render-invoice-pdf` for PDF generation with embedded Japanese font (M+ 1p).
- STF `render-invoice-docx` for Word document generation with MS Gothic font.
- Optional issuer logo embedding (PNG / JPEG via base64) for both PDF and DOCX.
- Reference files: requirements guide, tax rate master, and input JSON template.

### Fixed

- `render-invoice-docx` STF now uses an explicit
  `import { ... } from '@d6e-ai/docx';` statement instead of bare
  `const { ... } = docx;`. The d6e QuickJS runtime only injects
  `@d6e-ai/*` libraries when it sees a literal `import` statement in
  the STF source, so the previous form failed at execution time with a
  `docx is not defined` error.
- `render-invoice-pdf` and `render-invoice-docx` now unwrap
  `$input.normalized_payload` before reading any fields. This prevents
  blank PDF / DOCX output when an AI agent forwards the full
  `validate-qualified-invoice` response (including the `valid`,
  `errors`, and `normalized_payload` keys) rather than the flat payload.
- Generated file names now prefer `document_number` (sanitized for
  filesystem-illegal characters), then fall back to `transaction_date`,
  `issue_date`, and finally `undated`. Previously the file name relied
  on `transaction_date` alone, so downloads surfaced as
  `適格請求書_undated.pdf` whenever the date field was missing even
  though a document number was available.

### Added

- Two new workflows, `generate-invoice-pdf` and `generate-invoice-docx`,
  that validate the payload and render the invoice in a single
  deterministic run. Because d6e workflow return values are limited to
  the last STF output, the two formats are exposed as separate
  workflows and the AI calls both when the user wants both files.

### Changed

- `input_schema` of `render-invoice-pdf` and `render-invoice-docx`
  expanded from a four-field stub to the full invoice payload shape
  (kept in sync with `validate-qualified-invoice`). This gives LLM
  tool-callers complete field-level hints and lets runtime schema
  validation catch missing required fields before rendering.
- `template_prompt` now instructs the AI to prefer the new workflows
  over manually chaining the three STFs. Manual chaining remains
  available as a fallback for partial runs (e.g. validation only).
