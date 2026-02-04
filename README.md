# Ukrainian Institute for Systems Biology and Medicine (site)

## Publications (auto-updated)

- Data file: `data/publications.json` (committed to the repo so GitHub Pages can serve it as static content).
- Updater: `scripts/update-publications.mjs` (no external lookups; it builds `data/publications.json` only from the manual DOI list + records file).
- Manual completeness: add missing DOIs to `data/publications.dois.txt` (one DOI per line; DOI URLs are OK). For posters/non‑DOI items, add to `data/publications.records.json`.
- Author highlighting: add surnames to `data/publications.highlight.txt` (one per line).
- Automation: `.github/workflows/update-publications.yml` runs daily and commits updates to `data/publications.json`.

If the workflow cannot push commits, enable repo settings for Actions to have read/write permissions for `GITHUB_TOKEN`.
If that setting is greyed out (common in org/enterprise-managed repos), create a fine-scoped PAT and add it as `secrets.PUBLICATIONS_BOT_TOKEN`; the workflow will use it for checkout/push.
If you see “actions/* not allowed” errors, this repo policy blocks third-party actions; the workflow is implemented using only shell commands (no `uses:` steps).

## GitHub Pages settings

If you see a Pages error mentioning Actions/Jekyll builds, set `Settings → Pages → Build and deployment → Source` to **Deploy from a branch** (typically `main` + `/(root)`). This repo also includes `.nojekyll` to ensure the site is served as plain static files.
