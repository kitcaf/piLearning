---
name: arxiv-paper-access
description: Resolve arXiv papers by arXiv ID or paper title, inspect official arXiv metadata, and download arXiv PDFs through the local arxiv_paper_cli.py wrapper. Use this skill when Codex needs a tool-layer way to fetch one paper's arXiv metadata or PDF from a known arXiv ID, an arXiv URL, or an exact paper title. Do not use this skill for research-direction discovery, conference or journal paper-set construction, citation metrics, code availability, Semantic Scholar enrichment, or peer-reviewed venue evidence.
---

# arXiv Paper Access

Use this skill as a narrow paper-access tool layer.

This skill should not create research corpora. arXiv search results are query results, not bounded venue-year paper sets like DBLP proceedings. Use this skill only to resolve and download individual arXiv papers.

## Core Role

Follow this workflow:

1. Identify whether the user supplied an arXiv ID, arXiv URL, or paper title.
2. Use the bundled CLI to fetch metadata or resolve a title.
3. For title resolution, trust only high-confidence matches.
4. Download the PDF only after an ID is known or title matching is high-confidence.
5. Return the metadata, PDF URL, and saved PDF path.

## Hard Constraints

Always follow these rules:

1. Do not use arXiv search results as a stable paper dataset.
2. Do not perform direction discovery, opportunity finding, or venue-year collection here.
3. Do not claim citation counts, code availability, official publication venue, or peer-review status from arXiv metadata.
4. Do not auto-download from a title if the match is ambiguous.
5. If arXiv title matching fails, hand off to `$semantic-scholar-paper-search` only when the user or upper workflow needs a cross-source fallback.

## Bundled CLI

The CLI lives here:

- [scripts/arxiv_paper_cli.py](./scripts/arxiv_paper_cli.py)

Prefer invoking the sibling script directly. The commands below assume the working directory is this skill directory.

```powershell
python .\scripts\arxiv_paper_cli.py --help
python .\scripts\arxiv_paper_cli.py search-title --title "Attention Is All You Need"
python .\scripts\arxiv_paper_cli.py get --id 1706.03762
python .\scripts\arxiv_paper_cli.py download-pdf --id 1706.03762 --output-dir downloads
python .\scripts\arxiv_paper_cli.py download-pdf --title "Attention Is All You Need" --output-dir downloads --require-high-confidence
```

The CLI prints JSON on success and exits non-zero on unsafe or failed operations.

## Task Map

### Fetch metadata by arXiv ID

Use this when the user gives an arXiv ID or URL.

```powershell
python .\scripts\arxiv_paper_cli.py get --id 2401.12345
```

The ID may include a version suffix such as `2401.12345v2`. The returned paper record includes title, abstract, authors, dates, categories, DOI if present, abstract URL, and PDF URL.

### Search by title

Use this when the user gives an exact paper title.

```powershell
python .\scripts\arxiv_paper_cli.py search-title --title "Exact English Paper Title"
```

The CLI tries conservative official arXiv API queries:

1. `ti:"full title"`
2. `ti:keyword AND ti:keyword ...`
3. `all:"full title"`

It then computes local title similarity. Only treat `match.confidence = high` as an automatic match.

The successful `selected_paper` includes `abstract`, `arxiv_id`, `abs_url`, and `pdf_url`, so upper-layer skills can use this command for abstract metadata enrichment without downloading the PDF.

### Download a PDF

Prefer ID-based download when an arXiv ID is already known:

```powershell
python .\scripts\arxiv_paper_cli.py download-pdf --id 2401.12345 --output-dir "D:\path\to\pdfs"
```

Use title-based download only with high-confidence enforcement:

```powershell
python .\scripts\arxiv_paper_cli.py download-pdf --title "Exact English Paper Title" --output-dir "D:\path\to\pdfs" --filename "001_short_title" --require-high-confidence
```

If title matching is ambiguous, report the candidates and do not download.

## Output Shape

Expect successful JSON with fields such as:

```json
{
  "source": "arxiv",
  "operation": "download-pdf",
  "match_mode": "title-search",
  "match": {
    "confidence": "high",
    "score": 0.97,
    "margin": 0.12
  },
  "paper": {
    "arxiv_id": "2401.12345v1",
    "title": "...",
    "abstract": "...",
    "authors": ["..."],
    "year": 2024,
    "published_at": "...",
    "updated_at": "...",
    "primary_category": "cs.CL",
    "categories": ["cs.CL"],
    "doi": null,
    "journal_ref": null,
    "abs_url": "https://arxiv.org/abs/2401.12345v1",
    "pdf_url": "https://arxiv.org/pdf/2401.12345v1"
  },
  "saved_path": "D:\\path\\to\\pdfs\\001_short_title.pdf"
}
```

## Relationship To Other Skills

- Use `$paper-reader` when a CSV paper list needs PDF download plus reading notes.
- Use `$semantic-scholar-paper-search` when arXiv cannot resolve the title, when the paper may not be on arXiv, or when cross-source open-access discovery is needed.
- Use `$dblp-paper-venue-fetch` for bounded venue-year paper collections.
- Use `$paper-direction-explorer` for title-level screening inside DBLP venue-year lists.

## Example Triggers

- "Download this arXiv paper PDF by title."
- "Get metadata for arXiv:2401.12345."
- "Resolve this paper title on arXiv and save the PDF."
- "Check whether this title has a high-confidence arXiv match."
