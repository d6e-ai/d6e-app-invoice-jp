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
