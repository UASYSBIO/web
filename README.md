# Ukrainian Institute for Systems Biology and Medicine (site)

## Publications (auto-updated)

- Data file: `data/publications.json` (committed to the repo so GitHub Pages can serve it as static content).
- Updater: `scripts/update-publications.mjs` (queries Europe PMC for items with the affiliation string `Ukrainian Institute for Systems Biology and Medicine`, then keeps PubMed articles + bioRxiv preprints).
- Matching: uses both an exact phrase query and a tokenized query that wildcards the last term (to catch affiliations like `... Medicine, <something>`).
- Tuning: set `AFFILIATION_ALIASES` (variants separated by `|` or newlines) or `QUERY` (advanced; overrides everything) in the workflow env if your institute appears under other spellings.
- Automation: `.github/workflows/update-publications.yml` runs daily and commits updates to `data/publications.json`.

If the workflow cannot push commits, enable repo settings for Actions to have read/write permissions for `GITHUB_TOKEN`.
If that setting is greyed out (common in org/enterprise-managed repos), create a fine-scoped PAT and add it as `secrets.PUBLICATIONS_BOT_TOKEN`; the workflow will use it for checkout/push.
If you see “actions/* not allowed” errors, this repo policy blocks third-party actions; the workflow is implemented using only shell commands (no `uses:` steps).

## GitHub Pages settings

If you see a Pages error mentioning Actions/Jekyll builds, set `Settings → Pages → Build and deployment → Source` to **Deploy from a branch** (typically `main` + `/(root)`). This repo also includes `.nojekyll` to ensure the site is served as plain static files.
