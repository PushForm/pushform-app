# PushForm documentation site

The public documentation at [docs.pushform.io](https://docs.pushform.io), built with [Astro Starlight](https://starlight.astro.build/).

```sh
pnpm docs:dev     # http://localhost:4321
pnpm docs:build   # static site in docs/dist
```

## Pages

Pages are Markdown or MDX files in `src/content/docs/`. A file's path is its URL: `src/content/docs/getting-started/first-model.md` is `/getting-started/first-model/`. Each page needs a `title` and a `description` in its front matter. Set `sidebar.order` to place it within its section.

Add a new section by creating a folder and adding it to `sidebar` in `astro.config.mjs`.

Write for people reading in a browser: explain the task and show the steps in order. Describe PushForm's own behavior, and check it against the app.

## The in-app help is separate

`help/` holds the guides AI Chat searches inside the app. They are written as short, self-contained task passages for retrieval, and the site does not build from them. When a change affects what users see, update both: the guide in `help/` and the matching page here.

## Publishing

The `docs` workflow runs only when something under `docs/` changes, apart from `docs/help/`. On a pull request it builds the site. On `main` it deploys `docs/dist` to the Cloudflare Pages project `pushform-docs` and checks that docs.pushform.io serves the new build. Run it by hand from the Actions tab to redeploy.
