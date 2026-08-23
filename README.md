# AO Gear Solver on Netlify

Static page + one serverless endpoint that records build codes.

## Layout

    public/index.html            the solver (rename gear-solver.html to index.html)
    netlify/functions/builds.mjs POST saves a build, GET lists them
    netlify.toml                 build + functions config
    package.json                 @netlify/blobs

## Deploy

    npm install
    npx netlify-cli login
    npx netlify init      # creates the site, links the repo
    npx netlify deploy --prod

Or push to GitHub and connect the repo at app.netlify.com -- set
publish directory to `public`, leave the build command empty.

## Local

    npx netlify dev       # serves the page and /api/builds together

## Endpoint

    POST /api/builds  {"code":"175,0,...|...","ep":1083.03}
    GET  /api/builds?limit=50

Netlify Blobs is provisioned automatically; there is no connection string
to configure.
