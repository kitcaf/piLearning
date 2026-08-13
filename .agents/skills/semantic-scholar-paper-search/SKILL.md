---
name: semantic-scholar-paper-search
description: Use this skill when a task involves searching Semantic Scholar papers, resolving a paper title to metadata including abstracts, inspecting the official Semantic Scholar API surface, fetching paper metadata, or downloading an open-access PDF by title or query through the local semantic_scholar_cli.py wrapper in this project.
---

# Semantic Scholar Paper Search

Use this skill when the user wants to work with Semantic Scholar specifically.

Trigger this skill for tasks such as:

- Search papers on Semantic Scholar by title or free-text query
- Resolve a title to Semantic Scholar metadata, including `abstract` when available
- Inspect the official Semantic Scholar Graph, Recommendations, or Datasets API
- Fetch paper metadata from the official Semantic Scholar API
- Download an open-access PDF when Semantic Scholar exposes `openAccessPdf.url`
- Explore which official API operations exist before choosing one

Do not use this skill for generic web search outside Semantic Scholar.

The CLI this skill wraps is stored in the same directory as this skill:

- [semantic_scholar_cli.py](./semantic_scholar_cli.py)

## Quick Start

Prefer invoking the sibling script directly. The commands below assume the working directory is this skill directory. If not, resolve the path relative to this `SKILL.md`.

```powershell
python .\semantic_scholar_cli.py --help
```

The script returns JSON on success, so it is suitable for agent chaining and structured parsing.

## Core Workflow

1. Identify whether the task is API discovery, paper search, metadata retrieval, or PDF download.
2. Use the smallest CLI command that fits the task.
3. Run the CLI with `python .\semantic_scholar_cli.py ...` or the absolute path resolved from this skill directory.
4. Read the returned JSON and extract only the fields the user actually needs.
5. For PDF downloads, report the final `savedPath`.

## Task Map

### Discover official API surfaces

List the supported official Semantic Scholar API specs:

```powershell
python .\semantic_scholar_cli.py specs
```

List operations from one spec:

```powershell
python .\semantic_scholar_cli.py operations --spec graph
```

Describe one operation before calling it:

```powershell
python .\semantic_scholar_cli.py describe --spec graph --operation-id get_graph_paper_title_search
```

Use `describe` when parameter names or request-body requirements are unclear.

### Search for papers

For an exact title, prefer the official title-match operation:

```powershell
python .\semantic_scholar_cli.py call --spec graph --operation-id get_graph_paper_title_search --param "query=MCDAN: A Multi-Scale Context-Enhanced Dynamic Attention Network for Diffusion Prediction" --param "fields=title,authors,year,venue,externalIds,openAccessPdf,isOpenAccess,url"
```

For title metadata enrichment with abstracts, prefer the bundled `search-title` command:

```powershell
python .\semantic_scholar_cli.py search-title --query "Exact English Paper Title" --fields "title,abstract,authors,year,venue,url,externalIds,isOpenAccess,openAccessPdf"
```

Use `selectedPaper.abstract` only when `match.confidence` is `high`. This command is intended for upper-layer workflows such as `$paper-direction-explorer` abstract refinement.

For broader retrieval, prefer relevance search:

```powershell
python .\semantic_scholar_cli.py call --spec graph --operation-id get_graph_paper_relevance_search --param "query=diffusion prediction" --param "fields=title,authors,year,openAccessPdf,url"
```

Useful Graph operations:

- `get_graph_paper_title_search`: best for exact paper titles
- `get_graph_paper_relevance_search`: best for general paper search
- `get_graph_get_paper`: fetch one paper by paper ID or supported external ID
- `post_graph_get_papers`: fetch multiple papers in one call

### Call arbitrary official Semantic Scholar APIs

Use `call` when the user wants a specific official endpoint.

Pattern:

```powershell
python .\semantic_scholar_cli.py call --spec <graph|recommendations|datasets> --operation-id <official_operation_id> --param "key=value"
```

For POST operations with JSON bodies:

```powershell
python .\semantic_scholar_cli.py call --spec graph --operation-id post_graph_get_papers --param "fields=title,authors,openAccessPdf" --body-json "{\"ids\":[\"ARXIV:2308.04266\"]}"
```

If the JSON body is large, write it to a file and pass `--body-json @path\to\payload.json`.

### Download an open-access PDF

Use this when the user wants a local PDF file.

```powershell
python .\semantic_scholar_cli.py download-pdf --query "MCDAN: A Multi-Scale Context-Enhanced Dynamic Attention Network for Diffusion Prediction" --output-dir downloads --filename mcdan --require-open-access
```

Behavior:

- The CLI first tries the official title-match API
- It falls back to official relevance search if needed
- It downloads only when `openAccessPdf.url` exists
- It returns JSON including `savedPath`, `pdfUrl`, and selected paper metadata

When checking whether a paper is downloadable, inspect:

- `selectedPaper.openAccessPdf.url`
- `data[*].openAccessPdf.url`

## API Key Handling

The CLI supports:

- `--api-key YOUR_KEY`
- `SEMANTIC_SCHOLAR_API_KEY`
- `S2_API_KEY`

Prefer environment variables when the key is already configured. Never echo secrets back to the user.

Many official endpoints work without an API key, but some may require one or benefit from authenticated limits.

## Output Expectations

The CLI prints JSON. Usually summarize only the fields relevant to the task:

- Search tasks: title, abstract when requested, authors, year, venue, paper URL, PDF URL
- API discovery tasks: operation ID, method, path, required parameters
- Download tasks: saved path, PDF URL, selected title

If the user asks for raw output, provide the relevant JSON excerpt or summarize the key fields faithfully.

## Failure Handling

If the CLI returns an error:

1. Read the error text carefully.
2. If the issue is parameter uncertainty, run `describe`.
3. If the issue is missing PDF, explain that Semantic Scholar did not expose `openAccessPdf.url`.
4. If the issue is authentication, suggest `SEMANTIC_SCHOLAR_API_KEY` or `--api-key`.

## Example Prompts That Should Trigger This Skill

- "Search this paper on Semantic Scholar and download the PDF."
- "Check whether Semantic Scholar has an official title match API."
- "Fetch this paper metadata from the Semantic Scholar API."
- "List the available operations in the Semantic Scholar recommendations API."
- "Turn this paper title into a local PDF file if Semantic Scholar exposes one."
