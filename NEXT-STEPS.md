# What's left for you

Everything below the deploy is already done: the folder is arranged, the solver
is in `public/index.html` with build-recording wired in, and the first commit
is made.

## 1. Create an empty repo on GitHub

Name it `ao-gear-solver`. Do NOT add a README, licence, or .gitignore --
this folder already has a commit and those would conflict.

## 2. Push (replace YOUR-USERNAME)

    git remote add origin https://github.com/YOUR-USERNAME/ao-gear-solver.git
    git push -u origin main

## 3. Deploy on Netlify

app.netlify.com -> Add new site -> Import an existing project -> GitHub ->
pick `ao-gear-solver`, then set:

    Build command:       npm install
    Publish directory:   public
    Functions directory: netlify/functions

Press Deploy. First build takes about a minute.

`npm install` is what pulls in @netlify/blobs. Skip it and the page will load
but every save returns a 500.

## 4. Check it

Open the site, press F12, and in the console run:

    await (await fetch('/api/builds')).json()

Expect `{count: 0, items: []}`. Solve a build, run it again, and the build
should be listed.

## Already verified locally

- The page solves and renders correctly with recording wired in.
- A POST to /api/builds is attempted with the right JSON body.
- When the endpoint is missing the failure is swallowed: a console warning,
  no unhandled rejection, no effect on the solver.
- builds.mjs parses cleanly and handles both GET and POST.
