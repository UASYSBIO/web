# Ukrainian Institute for Systems Biology and Medicine (site)

## Publications (auto-updated)

- Data file: `data/publications.json` (committed to the repo so GitHub Pages can serve it as static content).
- Updater: `scripts/update-publications.mjs` (queries Europe PMC for items with the affiliation string `Ukrainian Institute for Systems Biology and Medicine`, then keeps PubMed articles + bioRxiv preprints).
- Automation: `.github/workflows/update-publications.yml` runs daily and commits updates to `data/publications.json`.

If the workflow cannot push commits, enable repo settings for Actions to have read/write permissions for `GITHUB_TOKEN`.
